# Jordan VPN — Android client (skeleton)

This is the app that can do what the browser cannot: open the tunnel itself.

**Status: skeleton. It has never been compiled or run.** The environment this
was written in has no Android SDK, so treat every file here as a starting point
that a build on your machine will need to correct, not as a shipped app. What is
here is the structure and the parts that do not depend on the SDK: the API
client, the `vless://` parser, the Xray client-config builder, the VPN service
lifecycle, and the connect UI.

## What is missing before it can connect

Two native pieces, both deliberately left out rather than stubbed into
something that looks like it works:

1. **An Xray runtime.** Build [libXray](https://github.com/XTLS/libXray) with
   gomobile into an `.aar`, drop it in `app/libs/`, and enable the commented
   dependency line in `app/build.gradle.kts`.
2. **A TUN-to-SOCKS forwarder** — `hev-socks5-tunnel` or a `tun2socks` build.
   `VpnService.Builder.establish()` returns a file descriptor carrying raw IP
   packets; something has to read that descriptor and speak SOCKS5 to the Xray
   inbound on `127.0.0.1:10808`.

Then replace `NotWiredXrayBridge` in `vpn/XrayBridge.kt` with a real
implementation. Until that exists, pressing START surfaces the error instead of
claiming to be connected — an app that says "connected" without a tunnel is
worse than one that says it cannot start.

## How it fits the rest of Jordan

```
customer buys on the web storefront  ──▶  control plane provisions a subscription
                                             │
             this app signs in ──────────────┘
             fetches /sub/<token>  ──▶  vless:// profiles (first hop only)
             builds an Xray client config  ──▶  VpnService TUN  ──▶  gateway
```

The app never chooses an egress; the control plane does that, and failover
reaches the app the same way it reaches every other client — the subscription
returns a different gateway set. That is why the app refetches the subscription
URL on every refresh instead of caching a config forever.

## Why the configs are on the connect screen

Other clients put the config list on its own tab. Switching server is the thing
people do most often, and a separate screen turns a one-tap action into
navigation: leave the screen, find the row, come back to connect. Here the list
sits under the card and scrolls on its own, so the switch, the active
configuration and the choice of server are all visible at once. Selecting a
different config while connected re-establishes the tunnel on it rather than
leaving traffic on the old one.

## Deliberate product decision: no in-app purchase

Buying stays on the web storefront. Selling VPN access for cryptocurrency
inside a store-distributed app runs into both the store's payment rules and its
review policies; keeping payment on the web keeps the app itself simple and
reviewable. The app opens the storefront in a browser when a subscription has
run out.

## Build (on a machine with the Android SDK)

```sh
cd android
./gradlew assembleDebug          # after adding the Gradle wrapper
# set the control plane the app talks to:
#   app/build.gradle.kts -> buildConfigField CONTROL_PLANE_URL
```

The Gradle wrapper is not committed here (it is a binary jar); generate it with
`gradle wrapper --gradle-version 8.11` on first checkout.

## Seeing the screen before you can build

`preview/connect-screen.html` is a mockup of the connect screen — the same
layout, spacing and colours as `ui/Screens.kt`, rendered as HTML so the design
can be reviewed on a machine with no Android toolchain. **It is a mockup, not a
screenshot**: it connects to nothing and measures nothing. Open it in any
browser.

The page opens with the switch enlarged in all three states so its geometry can
be judged on its own, then shows the whole screen: OFF, connecting (the switch
has moved but the thumb is still grey, with a green light travelling around
it), and connected (the thumb itself turns green and the light is gone).

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
| `data/ControlPlaneClient.kt` | Sign in, read the subscription, fetch profiles |
| `data/SessionStore.kt` | Session token and subscription URL in EncryptedSharedPreferences |
| `data/SubscriptionRepository.kt` | Refresh-then-fallback profile loading |
| `core/VlessProfile.kt` | Parses `vless://` — first hop only |
| `core/XrayConfigBuilder.kt` | Client config, with the control plane routed direct |
| `vpn/JordanVpnService.kt` | TUN setup, foreground service, lifecycle |
| `vpn/XrayBridge.kt` | The seam where the native runtime plugs in |
| `ui/MainActivity.kt`, `ui/Screens.kt` | Consent flow, connect screen with the config list, account tab |
| `core/Latency.kt` | Real TCP handshake timing behind the PING button |
| `preview/connect-screen.html` | Mockup of the connect screen (not a screenshot) |
