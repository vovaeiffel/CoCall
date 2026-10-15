# Virtual networks and addresses

[← Back to the contents](../../README.en.md)

CoCall has no central server: participants connect to each other directly. For that they need to "see" each other over a network. The easiest way is a **virtual local network**: a special program creates a shared "network room" where everyone gets their own address, as if you were all on the same Wi-Fi.

## What works

| Option | Rooms by address | Room discovery and network chat | Note |
| --- | --- | --- | --- |
| [Radmin VPN](https://www.radmin-vpn.com/) | yes | yes | the main option, everything was tested on it |
| Hamachi, ZeroTier | yes | should work | similar to Radmin, not tested in detail |
| Home network (Wi-Fi / cable) | yes | yes | if everyone is at home on one network |
| Tailscale | yes (by address) | no | network broadcasts don't pass there |
| Direct over the internet | yes, if the host opened a port | no | needs a port forwarded on the router, doesn't always work |

"Room discovery" and "Network chat" rely on a network broadcast (UDP, port 47831) that only reaches inside one network.

## Radmin VPN, step by step

1. Everyone downloads and installs Radmin VPN.
2. One person picks "Create network" in Radmin VPN, makes up a name and a password and tells friends.
3. The others pick "Join network" and enter the same name and password.
4. Everyone gets an address like `26.x.x.x` in the Radmin window.
5. The rest happens in CoCall: the host creates a room, the others join from the list or by address.

CoCall finds the Radmin address by itself and shows it in the "Address on the Radmin VPN network" block, so there's nothing to copy by hand.

## Ports and firewall

- A room listens on port **8080** on the host's computer (TCP).
- Room discovery and network chat use port **47831** (UDP).
- Voice, camera and screen go directly between participants. No ports need to be opened for them, but nothing should block the traffic between participants.

When you create a room for the first time, Windows may ask whether to allow the program to use the network. Click "Allow". If friends can't connect to you while Radmin works, check that Windows Firewall isn't blocking CoCall (Windows settings → Firewall → "Allow an app through firewall"). Windows can treat a virtual network as "public", where access is stricter: if so, allow the app for public networks too.

You can test the connection with the **"Diagnostics"** button on the main screen: it can check a host's address without joining the room.

## Connecting directly over the internet

This is a fallback. The host needs to:

1. Find their external address: it's shown in the "Over the internet" block (if it couldn't be detected, there's no internet access or the address lookup service is unavailable).
2. Open port 8080 (TCP) on the router and forward it to the host's computer.
3. Have a public ("white") address from the provider, not a shared one.

If any of this fails, use a virtual network. For most home connections it's simpler and more reliable.

To set up direct voice connections over the internet, the app uses Google's public STUN servers (`stun.l.google.com`); this is only used to establish the connection. The app has no relay server (TURN) by default, so behind a strict NAT the connection may fail.
