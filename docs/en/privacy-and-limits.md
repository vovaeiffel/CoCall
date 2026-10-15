# Privacy and limits

[← Back to the contents](../../README.en.md)

Here's what is usually written in small print. This is a hobby program and we'd rather say things plainly.

## What is sent where

| What | How | Encrypted? | Who can see it |
| --- | --- | --- | --- |
| Voice, camera, screen share | directly between participants (WebRTC) | yes (by WebRTC) | room participants only |
| Room chat messages, images, files, avatars | through the host's computer, plain WebSocket (`ws://`) | **no** | the host (can technically see everything) and participants |
| Room password | sent to the host when joining | **no** | the host, and anyone who can "listen" to the network between you |
| Network chat on the main screen | broadcast over the network (UDP) | **no** | everyone on your network running the app |
| Room announcement (name, host name, number of people, whether there's a password) | broadcast over the network (UDP) | **no** | everyone on your network |

The room password keeps random people out, but it is **not protection against whoever controls the network** or the host themselves.

## Who sees what

- **Participants can see each other's IP addresses.** This comes with direct connections. In Radmin VPN these are the virtual network addresses, not home ones.
- **The host can see the whole room chat**, because messages go through their computer. Choose a host you trust. The host can also remove a participant from the room.
- **Names aren't verified.** In room chat and network chat anyone can write under any name.
- **Network chat is open to everyone on your network**, including people you don't know if you're on a big shared network. Don't write anything personal there.

## What the app contacts

- **GitHub**: checks at startup for a new version and downloads it when you click the button.
- **api.ipify.org**: to show your external address in the "Over the internet" block.
- **Google STUN servers** (`stun.l.google.com`, `stun1.l.google.com`): help establish direct connections. Technical connection data is sent, not audio.
- No other requests. The app sends no statistics or telemetry, and there are no accounts.

## What is stored on your computer

Settings (name, devices, volumes, hotkey, look, the list of remembered rooms, your avatar) are stored locally in the app's data. The app doesn't save message history: it lives while a room is open (the host gives the last 100 messages to people who join later) or while the app is open (network chat). Your sound packs are in the app's data folder; the "Open packs folder" button opens it.

## Limits

- **Windows only.** The installer is built and tested on Windows.
- **Up to 8 people in a room, up to 4 cameras, one screen share at a time.** Everyone connects to everyone, so the load on your connection grows quickly.
- **Files up to 50 MB.** A file goes from the sender to whoever clicks "Download" through the host's computer.
- **Stream sound** includes friends' voices (see [Features](features.md#stream-sound-and-friends-voices)).
- **Network chat and room discovery** only work inside a shared network. They don't work over Tailscale or directly over the internet.
- **Host handover** only works if participants can reach each other directly. If the host loses their internet while you and the others stay on a shared network, the room moves. If everyone loses internet, the room closes.
- **No relay server (TURN).** Behind a strict NAT or with some providers a direct connection may fail. In a virtual network this usually doesn't happen.
- **The installer is not signed** with a paid certificate: Windows will warn you on first launch.
- **No protection from a malicious person inside the room** other than the password and the host's ability to remove a participant.

If you find a security problem, write via [issues](https://github.com/vovaeiffel/CoCall/issues), but don't publish other people's data.
