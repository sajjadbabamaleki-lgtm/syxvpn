---
title: A VPN can say connected and still carry nothing
description: The switch turns green the moment the tunnel process starts, which is not the same as traffic reaching the internet. Here is why the two get confused, and what an app should check instead.
date: 2026-09-13
updated: 2026-09-13
---

A VPN app has two questions to answer, and most of them only answer the first.

The first is whether the tunnel **started**. The core read its configuration,
opened its socket and did not throw. That is a local fact, known in
milliseconds, and it is what the switch on almost every client is actually
reporting.

The second is whether traffic **arrives**. That is a fact about a machine in
another country, the route to it, and whether that machine still recognises
your credentials. It cannot be known locally and it cannot be known instantly.

## Why the gap is invisible

A gateway that has forgotten your account starts exactly as cleanly as one that
works. So does a gateway whose handshake is being cut on the path. In both
cases the client's core accepts the configuration, opens its interface, and
reports success — because from where it is standing, everything it was asked to
do succeeded.

The result is a screen that says CONNECTED with both byte counters at zero and
no error anywhere, which is the worst possible failure: it looks like a slow
connection, so people spend an evening blaming their internet.

## What to check instead

Three signals, in increasing order of what they prove:

1. **The port answers.** A TCP handshake to the gateway. It proves the first hop
   is reachable on this network and nothing else at all.
2. **The tunnel is accepted.** The handshake completes and the credential is
   recognised. Still says nothing about the far side.
3. **A real request comes back.** Something is fetched *through* the tunnel and
   returns. This is the only one that means the path works end to end.

Only the third is worth calling "connected". It is also the only one that costs
a round trip, which is why clients skip it.

## Reading the symptom yourself

If a client claims to be connected and nothing loads, the byte counters settle
the question in a second. Zero up and zero down after a page load attempt means
no tunnel, whatever the switch says. Non-zero and slow is a different problem
with different causes: the route, the congestion control on the server, or the
link you are on.

They are not the same fault and they do not have the same fix, so it is worth
knowing which one you have before changing anything.
