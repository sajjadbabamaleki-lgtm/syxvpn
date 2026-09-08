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

It shows both states deliberately: the left phone is what the skeleton does
today (the bridge is not wired, so pressing connect surfaces that error and the
counters stay at zero), and the right one is the same screen once a real Xray
runtime is in place.

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
| `ui/MainActivity.kt`, `ui/Screens.kt` | Consent flow, connect screen, account tab |
| `core/Latency.kt` | Real TCP handshake timing behind the PING button |
| `preview/connect-screen.html` | Mockup of the connect screen (not a screenshot) |
