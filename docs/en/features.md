# Features

[← Back to the contents](../../README.en.md)

![Settings](../img/settings.png)

Settings open with the sliders button at the bottom of a room. The sections on the left: **Audio**, **Video**, **Sounds**, **General**.

## Voice

**Devices.** In "Audio" pick your microphone and output device (speakers or headphones).

**Volume.** Microphone (input) volume goes up to 200%, the overall volume of others up to 400%. Each participant also has their own volume (up to 400% too): **right-click** their card; you can mute them there as well. The volume is remembered by name. The host can use the same menu to remove a participant from the room.

**Noise suppression.** Three modes:

- **RNNoise (neural network, best)** removes keyboard, fan and hum and keeps the voice. It runs entirely on your computer. If it fails to start, the app switches to standard suppression and tells you.
- **Standard (built into the browser)**.
- **Off**.

**Microphone activation threshold.** A slider from 1 to 100: sound quieter than the threshold isn't sent (this cuts quiet noise while you're silent). Move it and watch the level indicator. The "speaking" highlight on a participant uses the same threshold.

**Hotkey.** Turns the microphone on and off even when the window is minimized. Click "Assign" and press the key or combination, for example `Ctrl+Shift+M` or `F8` (Esc cancels). A letter, digit or space needs Ctrl, Alt or Shift. "Reset" removes the hotkey. If another program already holds the key, CoCall tells you.

## Screen sharing

The monitor button at the bottom of a room. The picker shows your screens and windows with thumbnails.

- **Quality**: 1080p, 720p or 480p. Higher quality needs a faster connection (roughly 12, 6 and 2.5 Mbit/s). If your connection is weak, pick a lower one.
- **Priority**: "smooth motion" (for games) or "sharp detail" (for text and code).
- **Computer sound**: the "Share computer sound" checkbox. See the [limitation below](#stream-sound-and-friends-voices).
- Only **one** participant can share their screen at a time.
- Others see a "is sharing their screen" card and click **"Watch"**. While nobody watches, no video is sent.
- You can change the quality without stopping the share. To stop, use the button in the sharing bar or close the window being shared.

### Stream sound and friends' voices

If computer sound sharing is on, everything the computer plays goes into the stream, including your friends' voices from CoCall. The app can't exclude its own sound yet. Workarounds:

- untick "Share computer sound" (then viewers won't hear the game);
- play CoCall voices and the game on **different devices** (for example, voices in headphones, the game on speakers);
- ask viewers to turn on sound in your game window rather than in the stream.

## Webcam

The camera button. Quality: 360p, 480p or 720p. The default device and quality are in "Video". **Up to 4 cameras** can be on in a room at once. If the limit is reached, the app tells you. Camera video replaces the avatar on the card.

## Participants

- **Pinning**: click a participant to enlarge them (handy for a camera or a stream). Click again to unpin.
- **Connection indicator**: the battery icon on a card shows the connection quality with that person. [Diagnostics](troubleshooting.md) gives details for each one.
- **Avatars**: chosen on the main screen. The picture is shrunk so it reaches everyone quickly.
- The **host** is marked with a crown.

## Room chat

On the right in a room. You can:

- write text and send **emoji** (the smiley button);
- send **images** (PNG, JPEG, WebP, GIF): paste from the clipboard, drag and drop, or use the paperclip;
- send **files up to 50 MB** (paperclip). A file is transferred only to someone who clicks "Download". Programs and scripts (`.exe`, `.bat` and similar) show a warning before downloading;
- use the history: people who join later see the last 100 messages. Files aren't part of the history.

The chat isn't saved after the room closes. There is spam protection.

## Network chat (main screen)

On the right of the main screen. Write to everyone currently on the same network as you (Radmin VPN, Hamachi, ZeroTier, home Wi-Fi) without joining a room. Messages don't go over the internet or to any server: they're broadcast over the network and kept only in memory while the app is open. Messages are up to 400 characters and you can send about five per five seconds. You need to enter your name, otherwise the chat is closed.

It's a plain shared "room on a shared network" without authentication: anyone on your network can write under any name. More: [Privacy and limits](privacy-and-limits.md).

## Rooms

- **Rooms on your network**: rooms created with discovery on appear automatically (name, host name, number of people, a password mark).
- **Rooms you have visited**: rooms you've been in stay in the list, and the app shows whether the room is running now.
- **Leaving**: the host can leave the voice part and keep the room open, or close the room completely.

## Keeping the room alive

- If the connection drops, the app tries for 15 seconds to get back to the same server.
- If that fails and the host is gone, **the host role passes to the next participant** (in the order they joined) and the others reconnect to them automatically. This only works if participants can reach each other directly over the network (for example, in Radmin). The new host gets the chat history from the others.
- If you come back after the room has already moved to someone else, you'll end up in your own empty room: join the new host's room.

## Sounds

In "Sounds": turn the event signals on or off and set their volume (someone joined or left, screen sharing started or ended, a new message, microphone on and off). Signals are sound only, there are no pop-ups.

- **Packs**: ready-made packs like the ones in the `sounds` folder. Your own pack is a folder with files `join.mp3`, `leave.mp3`, `message.mp3` and so on. Put it into the folder opened by the button and click "Refresh list".
- **Custom sounds for events**: you can replace any sound with your own file (mp3, wav or ogg up to 3 MB, short is best). A custom sound beats the pack.
- If a file is missing, a built-in signal plays.

## Look and language

- **Color scheme**: Settings → General → Color scheme: Standard, Light, Dark or Custom. With Custom you pick the background, text and accent colors and the other shades are derived. If the text is hard to read on the chosen background, the app warns you.
- **Language**: the globe button in the top right of the main screen. Currently Russian and English. To add your own language, see [building](building.md#adding-a-language).

## Minimizing to the tray

By default the cross minimizes the app to the tray instead of closing it. The room and sound keep working. To quit completely, right-click the tray icon and choose "Quit completely". The same menu lets you open the window and turn the microphone on or off. You can turn this off in Settings → General.

## Diagnostics

The "Diagnostics" button on the main screen and in "General". It checks the version, microphone, speakers, camera, network, reachability of service servers (STUN) and the connection speed to each participant. You can check a host's address without joining the room and copy the report to send to the developer.
