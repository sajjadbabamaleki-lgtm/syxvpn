---
title: Why the fastest ping is often the slowest server
description: Ping measures the first hop. It says nothing about whether the gateway can still reach the internet, or how much it can carry once it does. What to measure instead.
date: 2026-09-13
updated: 2026-09-13
---

Every server list sorts by ping, and ping is the weakest signal on the page.

A ping is a round trip to the gateway's front door. It tells you the machine is
up and how far away it is. It does not tell you whether the machine can still
reach the internet behind it, whether its upstream is saturated, or whether the
route carrying your traffic is being shaped.

## Three different numbers

- **Latency** is how long a round trip takes. It decides how a page *feels* while
  it loads, because a page load is dozens of round trips.
- **Throughput** is how much arrives per second. It decides how long a download
  takes, and it is nearly independent of latency.
- **Loss** is what fraction of packets never arrive. It quietly destroys
  throughput, because the usual congestion control reads loss as "slow down".

A gateway can answer in 20 ms and carry two megabits. Another can answer in
400 ms and carry two hundred. Sorted by ping, the list puts the wrong one first.

## Loss is the one that hurts

On a long international path, a small amount of loss costs a great deal of
speed. The default algorithm on most servers, CUBIC, treats every lost packet as
a signal that the network is congested and backs off. On a path that drops
packets for reasons other than congestion — shaping, a saturated exchange, a
lossy last mile — it spends its life backing off from a problem that backing off
does not fix.

BBR is the usual answer. It models the path's actual bandwidth and round trip
instead of guessing from loss, and on a lossy long-haul link the difference is
routinely several times the throughput. It is one setting on the server:

```
net.core.default_qdisc=fq
net.ipv4.tcp_congestion_control=bbr
```

That is worth doing before blaming the gateway.

## What a client should measure

The honest measurement is a real request through the tunnel, timed. It costs a
round trip and it is the only thing that reflects all three numbers at once: a
gateway with a dead upstream fails it outright, and a gateway with a shaped
route is visibly slower at it than its ping suggests.

Ranking on that, and keeping what was learned between sessions, gets you a list
where the top entry is usually the right one. Ranking on ping gets you a list
that is sorted, which is not the same thing.
