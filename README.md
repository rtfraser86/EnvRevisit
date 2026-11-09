# EnvRevisit — repeat photo-point monitoring for iPhone

Map every geotagged photo in your camera roll, walk back to where one was taken, and retake it with a ghost overlay and heading / pitch / roll guidance. Each spot becomes a **station** that holds a time series you can swipe, scrub and compare.

Built with Expo (React Native), SDK 58. Stages 1–2 run in the free **Expo Go** app — no Mac, no Apple Developer account.

---

## Run it on your iPhone from Windows

1. **Install Node.js** (LTS) on your PC: https://nodejs.org
2. **Unzip** this folder somewhere, e.g. `C:\dev\EnvRevisit`.
3. Open **PowerShell** in that folder and install dependencies:
   ```powershell
   npm install
   ```
4. On the iPhone, install **Expo Go** from the App Store.
5. Start the dev server:
   ```powershell
   npx expo start
   ```
   Scan the QR code with the iPhone camera. The phone and PC must be on the same Wi‑Fi.
   If it can't connect (work networks often block it), use:
   ```powershell
   npx expo start --tunnel
   ```
6. Allow **Photos (Full Access)**, **Location** and **Camera** when asked. With "Limited" photo access you'll only see the photos you picked.

Edit any file in `src/` and the app reloads on the phone.

---

## How it works

| Screen | What it does |
|---|---|
| **Map** (`src/app/index.tsx`) | Indexes geotagged photos (incremental after the first scan), clusters them on a satellite map, shows stations as green diamonds. When you're within 150 m of earlier photos it zooms to them and lists them, nearest first. |
| **Photo** | Shows date, position, GPS accuracy and camera heading read from EXIF. "Revisit this spot" creates a station with that photo as the reference. |
| **Station** | The time series. Long-press a photo to make it the alignment reference or remove it. "+ Add older photos" pulls in other camera-roll shots taken within 15–250 m. Exports a CSV capture log. |
| **Navigate** | Stake-out style: north-up satellite map with an arrow at your position always pointing to the photo point, a dashed line to it, a green circle showing the GPS "on the point" radius, and a HUD with distance, bearing and N/E offsets. Below the map, a compass-relative arrow with "x m ahead · y m left". Haptic buzz when you're on the point. Pan the map to stop auto-follow; tap Re-centre to resume. |
| **Capture** | Camera framed to the reference's aspect ratio, with the old photo as a ghost: **Blend** (opacity slider), **Split** (drag divider), **Flicker**, **Off**. A target ring shows where the reference view's centre is — move until it covers the cross. Readouts say "Turn right 4°", "Tilt up 2°", "Level ✓". A stake-out chip shows distance and "x m ahead · y m left" relative to where the camera points, so you can fine-tune your position. **✎ Stamp** adds two note lines and/or the date. |
| **Timeline** | **Swipe** between dates, **Scrub** a slider that cross-fades through the whole series, or **Compare** any two dates with a divider. |

### Stamps (notes + date)
- Tap **✎ Stamp** on the camera screen to turn stamping on, type up to two note lines and choose whether to show the date and time. Settings are remembered per station.
- The app keeps every photo **clean** and stores the notes as data, so alignment and change detection aren't affected. Stamps are drawn as an overlay.
- When "Also saving to Photos" is on, the copy saved to Photos **has the stamp burnt in**, like a field-stamp camera app.
- On a station, long-press any photo to add or edit its notes (camera-roll photos too). The **Show stamps on photos** switch turns stamps on or off for the whole sequence, and so does the **Stamps** pill in the Timeline.
- Notes are included in the CSV export.

### Where the guidance numbers come from
- **Position**: phone GPS, about ±3–5 m at best. Final alignment is visual (the ghost).
- **Heading**: iOS compass, true north. Camera-roll photos usually record the camera heading in EXIF (`GPSImgDirection`).
- **Pitch / roll**: device motion sensors. iPhone Camera doesn't store these, so a station created from a camera-roll photo gets heading guidance only. The **first photo you take in EnvRevisit** fills in pitch and roll, and every later visit gets full 3-axis guidance.
- Photos taken in EnvRevisit embed GPS, heading and a JSON `UserComment` with pitch/roll/orientation in their EXIF. They are saved in the app *and* (by default) in an **EnvRevisit** album in Photos.
- **Landscape and portrait** both work. Pitch and roll come straight from the gravity vector, the app detects which way you're holding the phone, and the ghost, grid and guidance rotate to stay upright. Roll is measured relative to the frame you're shooting in, so a level landscape shot reads 0°. If the original was landscape and you're holding the phone upright (or vice versa), an orange banner tells you to turn it.

### First field check (2 minutes)
The capture screen shows live `hdg / pitch / roll` numbers under the guidance line.
1. Hold the phone upright in portrait, looking at the horizon. Pitch and roll should read near 0.
2. Tilt the top of the phone back (camera looking up). Pitch should go positive, the readout should say "Tilt down", and the ring should move down.
3. Turn right. Heading should increase and the ring should slide left.
4. Turn the phone sideways (either way) facing the same direction. Pitch and roll should again read near 0, and **heading should stay roughly the same** as in portrait. If heading jumps by about 90° in landscape, tell Claude.

If any sign is backwards, tell Claude which one. It's a one-line fix in `src/lib/sensors.ts` or `src/components/alignment-guide.tsx`.

### Data
All data stays on the phone in SQLite (`revisit.db`). Tables: `photos` (camera-roll index), `stations`, `captures`. CSV export columns: station, capture id, UTC time, source, uri, lat/lon, GPS accuracy, heading, pitch, roll, size, reference flag. This is the hand-off to a Python change-detection pipeline.

---

## Known limits of this build
- Automatic alignment needs the EnvRevisit build (see below), not Expo Go.
- On-screen buttons stay in portrait position when you turn the phone sideways (the overlays rotate; the controls don't).
- **Lens**: the camera opens at 1×. A reference shot at 0.5× or 2× won't line up yet.
- iCloud-only originals may be slow to appear the first time.

---

## Automatic alignment (EnvRevisit build only)
Every photo in a station is registered to the station's reference photo: ORB features (OpenCV), ratio-tested Hamming matches, a RANSAC homography (pure JS, `src/lib/homography.ts`) and an OpenCV `warpPerspective` into the reference frame (long side 2048 px). Originals are untouched; aligned copies live in the app's `aligned/` folder.
- New photos taken in the app are aligned automatically right after you shoot.
- **Station → Automatic alignment → Align / Re-align** processes the whole sequence (e.g. older camera-roll photos). Changing the reference re-aligns everything.
- Green ⇄ badge = aligned, orange ! = couldn't align (too different: viewpoint, season, light or lens).
- **Timeline → Aligned / As shot** switches between registered and original photos.
- Not available in Expo Go. The rest of the app still runs there.

## Building the EnvRevisit app (development build)
Needs the Apple Developer Program and your Expo account. All from the PC, in the project folder:
1. Log in to EAS (your `EXPO_TOKEN` also works):
   ```
   npx eas-cli@latest login
   ```
2. Register your iPhone (open the link it shows on the phone and install the profile):
   ```
   npx eas-cli@latest device:create
   ```
3. Build in Expo's cloud (asks for your Apple ID the first time; takes ~15–25 min):
   ```
   npx eas-cli@latest build --profile development --platform ios
   ```
   The first run asks to create an EAS project. Say yes. It adds a `projectId` to `app.json`, which you should commit and push, or send to Claude.
4. Open the link from the build on the iPhone to install **EnvRevisit**. On iOS 16+ also turn on **Settings → Privacy & Security → Developer Mode** and restart when asked.
5. From then on start the server with:
   ```
   npx expo start --dev-client
   ```
   and open the project from inside the EnvRevisit app (or scan the QR code). JavaScript changes reload live. Only adding new native libraries needs another build.

## Roadmap
**Next:** live image matching while lining up ("step left 0.4 m / closer" from the camera feed), lens matching (0.5×/2×), app icon, zip export of a station (originals + aligned + CSV).

## Project layout
```
src/app/            screens (Expo Router — file name = route)
  index.tsx           map
  photo.tsx           camera-roll photo → station
  stations.tsx        station list
  station/[id].tsx    station detail / time series
  add-photos/[id].tsx add older camera-roll photos
  navigate/[id].tsx   walk-to guidance
  capture/[id].tsx    ghost-overlay camera
  timeline/[id].tsx   swipe / scrub / compare
src/components/     UI pieces (slider, alignment guide, buttons)
src/lib/            db.ts (SQLite), library.ts (camera-roll scan + EXIF),
                    sensors.ts (GPS, compass, pitch/roll), geo.ts, storage.ts
```

Checks: `npx tsc --noEmit` and `npx expo lint`.
