# Troubleshooting

[← Back to the contents](../../README.en.md)

## First: "Diagnostics"

The **"Diagnostics"** button (main screen, top right, or Settings → General) checks the version, microphone, speakers, camera, network, STUN server reachability and the connection speed to each participant. Each problem comes with what to do about it. The "Copy report" button copies the report: handy to show to whoever is helping.

It can also check a host's address without joining the room: if that check fails, the problem is the network or firewall, not the app.

## I can't join a room

1. Make sure you're **on the same network** as the host: both of you run Radmin VPN (or another network) and see each other in it.
2. Check the address: `IP:port`, for example `26.1.2.3:8080`. The default port is 8080.
3. The host must have **created the room** (the app is running and the room is created).
4. If Radmin shows you to each other but CoCall doesn't connect, check Windows Firewall on the host's computer: the app must be allowed to use the network, including "public" networks. Windows sometimes treats a Radmin network as public.
5. If there's a password, check for a stray space.
6. The room is full: the maximum is 8 people.

## The room doesn't appear under "Rooms on your network"

- Discovery only works inside one network and only if the host left "Show the room to others on your network" ticked.
- It **doesn't work over Tailscale or the internet**: network broadcasts don't get there. Connect by address.
- The firewall may block UDP port 47831. Allow the app.
- Wait a few seconds: announcements come every 3 seconds, and a vanished room disappears after 10.

## Network chat is empty or says nobody is around

Network chat only sees people who are on the same network as you right now and have started CoCall with a name entered. It doesn't work over the internet or Tailscale. If you're alone on the network, there will be no messages.

## Nobody hears me / I can't hear anyone

- In "Audio" check the selected microphone and output device. If you plugged in headphones after the app started, switch the device by hand.
- If others can't hear you, the **microphone activation threshold** may be too high: lower it. If noise gets through while you're silent, it's too low.
- Windows → Settings → Privacy → Microphone: allow access for desktop apps.
- Check that the microphone isn't muted by the button or the hotkey.
- Diagnostics shows the link to each participant: a red battery indicator means a poor connection.

## Sound crackles or cuts out

- Try another noise suppression mode (RNNoise → Standard → Off).
- Close programs that load the processor heavily.
- If the connection is weak (red indicator), lower the screen share and camera quality or turn them off.

## Screen sharing: viewers hear friends' voices twice

This is a known limitation: with computer sound sharing on, everything the computer plays goes into the stream, including voices from CoCall. Untick "Share computer sound" or play voices and the game on different devices. More: [Features](features.md#stream-sound-and-friends-voices).

## Screen sharing is laggy or blurry

- Pick a lower quality (720p or 480p).
- For games choose the "smooth" priority, for text the "sharp" one.
- The picture takes a moment to reach full quality, give it a couple of seconds.

## The camera won't turn on

- Windows → Privacy → Camera: allow access.
- No other program should be using the camera.
- Only 4 cameras can run in a room at once. If the limit is reached, the app tells you.

## Windows complains during installation

The blue "Windows protected your PC" window appears for every program that isn't signed with a paid certificate. "More info" → "Run anyway". If antivirus deleted the installer or the app, that's a false alarm on an unsigned file. Add it to the exceptions or [build the app yourself](building.md).

## Auto-update doesn't work

- Did the banner appear with a "Download" button (not "Download and install")? Then the app didn't find the release files or isn't running from an installed copy. Download the installer from the releases page.
- The download broke off: the button becomes "Download manually", click it.
- Versions before 1.0.5 can't update themselves: install the new one by hand once.

## The app doesn't start or closes

- If you start the installed copy again, it just shows the window that's already open (it may be in the tray near the clock).
- If the problem persists, [open an issue](https://github.com/vovaeiffel/CoCall/issues) and attach the report from "Diagnostics".
