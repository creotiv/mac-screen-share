# Mac Screen Share

Stream your Mac's screen to any Android device (or any browser) on the same Wi-Fi network. Nothing needs to be installed on the Android device.

## Run

1. Install Node.js 18+ on the Mac (`brew install node`, or download it from nodejs.org).
2. In Terminal, run:
   ```
   cd mac-screen-share
   node server.js
   ```
3. On the Mac, open **http://localhost:8080/host** in Chrome, then click **Start sharing**.
4. On the Android device, open the `http://<mac-ip>:8080` address printed in Terminal. Tap the video to go fullscreen.

## Use it as an extended second screen

Out of the box this mirrors a screen. To get a real *extra* display:

1. Install **BetterDisplay** (free) and create a virtual display, e.g. 1920×1200.
2. When you click Start sharing, choose that virtual display.
3. Drag windows onto it in macOS. They'll appear on the Android device.

## Notes

- Video is sent peer-to-peer over WebRTC, using the browser's hardware encoder and decoder. The server only relays the small connection-setup messages.
- If the Android device can't connect, check the macOS firewall (allow incoming connections for `node`). Also check that the Wi-Fi network doesn't isolate devices from each other (common on guest and corporate networks).
- Change the port with `PORT=9000 node server.js`.
- Several devices can watch at the same time.
