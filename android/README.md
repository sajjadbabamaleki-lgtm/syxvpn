# Jordan VPN — Android client

This is the app that can do what the browser cannot: open the tunnel itself.

**Status: written in full, never compiled.** The environment this was written in
has no Android SDK and cannot reach Google's Maven, so treat every file here as
a starting point that a build on your machine will need to correct, not as a
shipped app. What has been checked is set out under "What can be checked without
the SDK" below — including that real Xray-core accepts the configuration this
app generates.

## The tunnel

There is exactly one native piece: **libXray**, Xray-core wrapped by gomobile.
There is deliberately no tun2socks, and that is not a shortcut.

Xray-core carries its own layer-3 stack (`proxy/tun`, gVisor), so the descriptor
from `VpnService.Builder.establish()` goes straight into the core and nothing
forwards packets in between. The descriptor cannot be passed as an argument: the
core reads it from the process environment under `xray.tun.fd`, and the config's
root `env` object is applied to the environment while the config is built. That
is the documented Android path in both projects, and it is what
`XrayConfigBuilder` writes.

The alternative — a Go tun2socks beside libXray — would not merely be redundant,
it would not load. Both embed a Go runtime, and Go does not support two
independently built runtimes in one process; libXray says so in its own README.

### Building the runtime

Needs Go, gomobile and the Android NDK:

```sh
git clone https://github.com/XTLS/libXray
cd libXray
python3 build/main.py android      # -> libXray.aar
cp libXray.aar <this repo>/android/app/libs/
```

The build picks it up by itself. `app/build.gradle.kts` looks for `libs/*.aar`
and, when it finds one, compiles `app/src/xray` (the real bridge) and adds the
dependency; when it does not, it compiles `app/src/noxray`, whose bridge refuses
to start and says why. No reflection, no runtime guessing, and an app that says
"connected" without a tunnel is never one of the two outcomes.

The AAR is git-ignored: it is tens of megabytes of native code and belongs in a
release pipeline, not in this repository.

### What the bridge does

`app/src/xray/.../LibXrayBridge.kt`. libXray exposes one entry point —
`Invoke(requestJSON) string`, `apiVersion: 3` — so each call is a small JSON
envelope: `runXray`, `stopXray`, `getXrayState`, `xrayVersion`.

Two things happen before the core starts, and both are why a VPN app cannot just
"run Xray":

1. Every socket the core opens is protected through the dialer and listener
   controllers, which call `VpnService.protect()`. The connection to the gateway
   must not be routed into the tunnel that connection is carrying.
2. Go's own resolver is pointed at a real DNS server with `setDNS`. While a VPN
   is up Android can hand Go a loopback resolver that only answers inside the
   tunnel, which would leave the gateway's hostname unresolvable.

The traffic counters on the connect screen are not the app's arithmetic: the
config starts Xray's metrics server on a loopback port and the bridge reads
`/debug/vars`, which is the core's own counter for the proxy outbound.

One thread owns the tunnel's lifecycle, so starting, stopping and closing the
descriptor cannot overlap — switching server twice quickly would otherwise leave
a second instance starting while the first is still shutting down, and Xray
refuses a second instance outright.

libXray states that it does not guarantee API stability. If a future release
renames a method, the compile breaks in `LibXrayBridge.kt` and nowhere else.

## How it fits the rest of Jordan

```
customer buys on the web storefront  ──▶  control plane provisions a subscription
                                             │
             this app signs in ──────────────┘
             fetches /sub/<token>  ──▶  vless:// profiles (first hop only)
             VpnService TUN fd ──▶ Xray-core tun inbound ──▶ vless+ws ──▶ gateway
```

The app never chooses an egress; the control plane does that, and failover
reaches the app the same way it reaches every other client — the subscription
returns a different gateway set. That is why the app refetches the subscription
URL on every refresh instead of caching a config forever.

## Automatic, or by hand

The switch works without anyone choosing a server. AUTO is the default, and it
is not a euphemism for "the first one in the list": when the switch goes on, the
tunnel decides, in the order of how much each source actually proves.

**What the control plane knows** outranks everything. It watches every gateway's
ingress *and* the egress behind it, continuously, and publishes a route state —
healthy, degraded, unverified — in `/sub/<token>?format=json`. The app reads
that form now; the plain base64 list is the fallback for a subscription hosted
anywhere else, and a server from it carries no route state rather than a
flattering guess.

**What the phone can measure** breaks ties inside a health class. A real TCP
handshake to each gateway, in parallel, with a 2.5 s ceiling. It says the first
hop is reachable on this network — and nothing about whether that gateway can
still reach the internet.

**What the core can prove** is the strongest evidence and the most expensive, so
it is spent on the best three: `pingBatch` builds a temporary instance per
candidate and makes a real request through it. That is why a gateway answering
in 20 ms with a dead egress loses to one that answers in 400 ms and works. With
no runtime bundled this returns nothing — no evidence rather than bad evidence,
and the handshake ranking decides alone.

Then it connects, and if a server refuses it walks down the rest of the list
rather than giving up: failover is the same ordering, not a second mechanism.
A server that failed its end-to-end test stays in that list, last — one refused
handshake is not proof a gateway is gone.

Switching servers costs every open connection, so an automatic re-pick keeps the
one in use unless the alternative is better in a way a person would notice: a
better health class, or 40 ms faster. Without that hysteresis two gateways a few
milliseconds apart would swap on every refresh.

Tapping a row is a statement, so it turns AUTO off and stays off. That decision
lives in `core/ServerPicker.kt`, which is ordinary Kotlin with no Android in it,
and `android/tools/PureLogicChecks.kt` runs 13 checks over it — including that
health beats latency, that a proven-dead egress loses to a slower working one,
and that the hysteresis holds in both directions.

## Two ways to use it, two tabs

The app has to serve two people. One wants what every VPN app gives them: an
app, a switch, and no idea what a config is. The other bought configs and wants
to see them, copy them, hand one to a friend and pick which server carries their
traffic. Those are different jobs, so they are different screens:

**VPN** is the switch, a card and a list of countries — the shape of an ordinary
VPN app, for someone who has never seen a `vless://` line and does not want to.
It carries no title: the space above the switch is the banner slot.

The card has two halves and both go somewhere: the top names the server in use
and opens the Configs tab, the bottom shows what is left of the plan and opens
the Premium tab. It carries no traffic counters; those are real numbers from the
core, so they moved to the tunnel's ongoing notification rather than being
dropped.

The countries under it are worked out, not shipped: a gateway's `region` starts
with an ISO country code by convention (`de-fra`, `nl-ams`), so when that is
what it looks like — and the code is a real country — the app names it with
`Locale` and draws its flag from regional-indicator letters, which every phone
already has. No image assets, and no flag for a place the operator never
claimed: a gateway whose region is `eu` or `lab` is offered under "Other
servers" instead. Choosing a country narrows automatic selection to it; the
measuring, the hysteresis and the failover all still apply, inside that country.

**Configs** is the same servers as themselves — hostnames, ports, route states —
under the same switch and the same card. Each row copies, shares or hides. This
is the tab for the person who bought configs and wants to handle them.

Both tabs carry the identical panel: banner slot, switch, state, card. Only the
list under it differs, countries on one and configs on the other. A switch that
appeared on one screen and not the other would make the second one feel like a
settings page rather than a way to connect.

There is no AUTO/MANUAL control any more, because tapping is the control:
choosing Automatic or a country on the VPN tab means the tunnel decides,
choosing a config on the Configs tab means that server and nothing else. The
card still says which of the two is in force, on the right of its top half —
that is a statement of what is happening, not a switch to set it.

The first version put the list under the switch precisely to avoid a separate
screen, and the concern behind that was right: switching server must not become
navigation. Two things keep it from becoming that. The card on the VPN screen is
a button into the Configs tab, so it is one tap away and always names the server
in use. And selecting a row there while the tunnel is up moves the tunnel onto
that server there and then, rather than making anyone walk back to the switch.

Both tabs read one state object, so neither can show a different answer to
"which server is this".

Rows have a fixed height (62) with a 13 gap. Selecting one by hand also ends
automatic mode: choosing a server is a statement, and the tunnel should not
quietly override it on the next connection.

## One colour

There is a single accent, and it is the green of the ON switch: green is what
the product asks you to press, and what "the tunnel is up" looks like. There is
deliberately no amber anywhere in the app. A state that is only being attempted
— connecting, a payment not yet confirmed — is neutral grey, so colour can never
imply a connection or a settlement that has not happened. Red stays for failure.

Every screen is inset 16 from the sides: the bar, the cards and the config rows
all sit on the same two vertical lines.

Both lists end on their third row — countries on the VPN screen, configs on the
Configs screen — and every pixel left over collects in one place at the top of
the screen: the banner slot. That is the whole reason the lists are capped. The
slot draws nothing at all in the app; an empty rectangle with "Ad" written in it
would be an advertisement for nothing, and a placeholder is a promise the app
has not kept. The mockup outlines it in a dashed line so the space can be
judged: about 358 x 200 on the VPN screen, and roughly twice that on Configs,
which has no switch to fill its middle.

## The other three tabs

`VPN` and `Configs` are above. The other three are one screen each:

**Premium** is the storefront. Plans come from `/api/v1/shop/plans`, "Buy with
USDT" opens a real order through `/api/v1/shop/orders`, and the screen then
shows the exact amount, the receiving address and the order's live state,
polling `/api/v1/shop/orders/:id` every ten seconds. Settlement happens on
chain: the app waits for the control plane's watcher to see the transfer and
never claims anything itself. The exact amount is the thing that attributes a
payment to an order, so it is copyable and is formatted from the integer
micro-USDT value the API returns — never through a float.

Ordering inside the app is right for a directly distributed APK and wrong for
Google Play, whose payments policy does not allow selling digital goods for
crypto in-app. It therefore sits behind one build flag, `IN_APP_ORDERS` in
`app/build.gradle.kts`: with it off, the same tab lists the plans and sends the
customer to the web storefront to pay.

**Support** shows the contact the deployment publishes (`SUPPORT_CONTACT` on
the control plane, served through `/api/v1/shop/config`), so the operator can
change it without shipping a new APK; when none is set the screen says exactly
that instead of offering a button that goes nowhere. A handle becomes a
`t.me` link, an address becomes mail, a URL is opened as it is. Below that sit
three things worth checking before writing, and a diagnostics block the
customer can copy into their message: app and Android version, device, control
plane host, account email, tunnel state and last error. It deliberately carries
no session token, no subscription URL and no UUID — the subscription URL alone
is enough to use the account, and support does not need it.

**Account** is the subscription: state, data used against the quota, expiry,
and a button that goes to Premium. The VPN screen carries a short version of the
same figures — data left and days left — drawn only once the control plane has
answered, so an unreachable API leaves the space empty rather than showing a
full bar nobody measured.

Before any of them there is the sign-in screen, which also creates accounts:
the first thing a new customer does is install the app, and sending them to a
browser to type the same two fields loses people. The password field is masked
with a deliberate Show toggle, and a 401 from the control plane returns the app
to this screen rather than leaving it signed-in-looking and failing every call.

The notification permission is asked for once on first launch (Android 13+) and
the answer is not acted on: the tunnel's foreground service runs either way,
a refusal only means the ongoing notification is not shown.

The bottom bar is drawn by hand rather than being a Material `NavigationBar`.
The default one puts a wide indicator capsule behind the selected icon and
brings its own metrics; this one is a floating slab in the same language as the
cards above it (radius 28, 1px border, `Surface` fill) with a small accent-tinted
block marking the tab you are on, and its four icons are one stroked set at one
weight.

## Build (on a machine with the Android SDK)

```sh
cd android
./gradlew assembleDebug
# set the control plane the app talks to:
#   app/build.gradle.kts -> buildConfigField CONTROL_PLANE_URL
```

The Gradle wrapper is committed, so `./gradlew` works on a fresh checkout. Its
`gradle-wrapper.jar` came out of the official `gradle-8.11.1-bin.zip` fetched
from services.gradle.org over TLS; verify it if you like:

    sha256  gradle/wrapper/gradle-wrapper.jar
            2db75c40782f5e8ba1fc278a5574bab070adccb2d21ca5a6e5ed840888448046

A debug build installs as `net.jordanvpn.app.debug`, so it can sit next to a
release build on the same phone.

### Signing a release

The keystore never enters the repository. Either write
`android/keystore.properties` (git-ignored):

    storeFile=/absolute/path/jordan-release.jks
    storePassword=...
    keyAlias=jordan
    keyPassword=...

or set `JORDAN_KEYSTORE`, `JORDAN_KEYSTORE_PASSWORD`, `JORDAN_KEY_ALIAS` and
`JORDAN_KEY_PASSWORD` for a CI build. With neither present the release build
still runs and is simply left unsigned, so a debug build never fails over a
missing key.

## What can be checked without the SDK

Most of the app cannot be compiled without the Android SDK, but the parts that
are ordinary Kotlin can — and they are the parts where a quiet mistake is
expensive, since a wrong amount does not settle an order:

```sh
kotlinc android/app/src/main/java/net/jordanvpn/app/core/SupportContact.kt \
        android/app/src/main/java/net/jordanvpn/app/ui/Format.kt \
        android/tools/PureLogicChecks.kt -include-runtime -d /tmp/checks.jar
java -jar /tmp/checks.jar
```

That covers micro-USDT formatting, byte, countdown and days-left formatting, ISO
parsing, support-contact parsing, server ranking and failover order, and the
region-to-country reading behind the VPN screen's flags.

**The Xray config the app generates, judged by real Xray-core.** This is the
one that decides whether the tunnel starts at all, and it needs no Android:

```sh
curl -sSLo /tmp/json.jar \
  https://repo1.maven.org/maven2/org/json/json/20240303/json-20240303.jar
kotlinc -cp /tmp/json.jar \
  android/tools/UriStub.kt \
  android/app/src/main/java/net/jordanvpn/app/core/VlessProfile.kt \
  android/app/src/main/java/net/jordanvpn/app/core/XrayConfigBuilder.kt \
  android/tools/XrayConfigCheck.kt -include-runtime -d /tmp/cfg.jar
java -cp /tmp/cfg.jar:/tmp/json.jar XrayConfigCheckKt > /tmp/xray.json
xray -test -config /tmp/xray.json          # any xray binary, e.g. lab/bin/xray
```

`android/tools/UriStub.kt` stands in for `android.net.Uri` so the parser and the
builder can run off-device. The TUN inbound, the descriptor in the root `env`,
the metrics server and the stats policy are all part of what gets validated.

**The bridge's call sites, against the libXray API.** `android/tools/stubs/`
declares that API as gomobile exports it, so the bridge type-checks with no AAR
present — which catches a misspelled method, a wrong arity, or an `Int` where
gomobile expects a `Long`:

```sh
kotlinc -cp /tmp/json.jar android/tools/stubs/*.kt \
  android/app/src/main/java/net/jordanvpn/app/vpn/XrayBridge.kt \
  android/app/src/xray/java/net/jordanvpn/app/vpn/LibXrayBridge.kt -d /tmp/bridge
```

It cannot prove the AAR you build exports exactly that — libXray does not
promise API stability — so check the release you build against.

## Seeing the screen before you can build

`preview/connect-screen.html` is a mockup of the screens — the same
layout, spacing and colours as `ui/Screens.kt`, rendered as HTML so the design
can be reviewed on a machine with no Android toolchain. **It is a mockup, not a
screenshot**: it connects to nothing and measures nothing. Open it in any
browser.

The page opens with the switch enlarged in all three states so its geometry can
be judged on its own, then shows the whole screen: OFF, connecting (the switch
has moved but the thumb is still grey, with a green light travelling around
it), and connected (the thumb itself turns green and the light is gone). Four
more frames follow: the Configs tab, the Premium tab's plans, an open USDT
order, and Support.

The switch is a two-segment control: both labels stay visible and the thumb
slides over the active one. Its geometry follows a single rule — the inset
equals the difference between the two corner radii, which is what makes the
curves concentric rather than merely close:

    pill   208 x 72   radius 36
    inset             12 on every side   (= 36 - 24)
    thumb   92 x 48   radius 24

The card and the config rows carry double that curvature (28 and 24), so the
switch, the card and the list read as one family rather than three radii.

Centring the labels needs three corrections, all of them measured rather than
eyeballed. The label row is inset by the same 12 as the thumb, so each half is
the thumb's width and the labels land on the thumb's centre — splitting the
full pill width instead puts them 6 off. Letter spacing is applied after the
last glyph as well, dragging centred ink half a space left. And Android's font
padding plus line leading reserves descender room that all-caps labels never
use, lifting the ink; `includeFontPadding = false` with a trimmed line height
removes it.

Measured on the rendered mockup, glyph ink rather than text box: horizontal
centres 58 and 150 against thumb centres of 58 and 150; vertical centre 36.1
against a pill centre of 36.

In the HTML mockup the pill's outline is an inset box-shadow rather than a
border: a border shrinks the padding box, which shifts every absolutely
positioned child and made the top gap a pixel larger than the bottom one. The
mockup's measured gaps are 12 on all four sides. The third frame is deliberately
mid-scroll to make the layout rule visible — only the config list moves; the
switch and the card above it stay where they are.

The colour rule is the point: green means the tunnel is up, never that it is
being attempted.

Note that the skeleton cannot actually reach the connected state yet: with no
Xray runtime bundled, moving the switch surfaces the bridge error and the
counters stay at zero.

## Files

| Path | What it does |
| --- | --- |
| `data/ControlPlaneClient.kt` | Sign in, subscription, plans, USDT orders, profiles |
| `data/SessionStore.kt` | Session token and subscription URL in EncryptedSharedPreferences |
| `data/SubscriptionRepository.kt` | Refresh-then-fallback profile loading |
| `core/VlessProfile.kt` | Parses `vless://` — first hop only |
| `core/XrayConfigBuilder.kt` | Client config, with the control plane routed direct |
| `vpn/JordanVpnService.kt` | TUN setup, foreground service, lifecycle |
| `vpn/XrayBridge.kt` | The seam the runtime plugs into, and socket protection |
| `src/xray/.../LibXrayBridge.kt` | The real runtime: libXray's Invoke API, metrics counters |
| `src/noxray/.../NotWiredXrayBridge.kt` | Compiled when no AAR is present; refuses to start, and says why |
| `ui/MainActivity.kt`, `ui/Screens.kt` | Consent flow, VPN and Configs tabs, premium, support and account |
| | the card's three tiles — down, ping, up — keep it one line tall |
| `core/Latency.kt` | Real TCP handshake timing behind the PING button |
| `core/ServerPicker.kt` | Ranking, hysteresis and failover order — no Android in it |
| `core/Country.kt` | Region to country, flag emoji, grouping — no Android in it |
| `core/SupportContact.kt` | Turns a support contact into an openable link |
| `app/proguard-rules.pro` | R8 rules for the release build |
| `preview/connect-screen.html` | Mockup of the screens (not a screenshot) |
| `tools/PureLogicChecks.kt` | Checks the SDK-free logic; runs with only `kotlinc` |
| `tools/XrayConfigCheck.kt`, `tools/UriStub.kt` | Prints the app's Xray config for `xray -test` |
| `tools/stubs/` | The libXray API as gomobile exports it, for type-checking without the AAR |
