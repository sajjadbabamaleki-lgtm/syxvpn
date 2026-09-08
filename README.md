# Jordan VPN

Jordan VPN is an experimental gateway and subscription-management platform for controlled network environments and resilience testing.

## MVP goals

- Per-user subscription URLs
- Multiple gateway registry
- Gateway health monitoring
- Quota and expiry tracking
- Failover-ready egress abstraction
- Xray-compatible profile generation
- Blackout-lab mode for testing restricted-network conditions

## Architecture

```text
Client (NPV Tunnel / V2Ray-compatible)
        |
        v
Subscription API
        |
        v
Gateway Manager
   |          |
   v          v
Gateway A   Gateway B
   \          /
    v        v
    Egress Manager
         |
         v
 Authorized / available upstream connectivity
```

The egress layer is intentionally abstract: the platform does not assume that any particular upstream route will remain reachable during a real network disruption.

## Status

Initial project scaffold.
