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
- On-screen buttons stay in portrait position when you turn the phone sideways (the overlays rotate; the controls don't).
- **Lens**: the camera opens at 1×. A reference shot at 0.5× or 2× won't line up yet.
- **No automatic image alignment yet.** The timeline shows photos as captured (see Stage 3).
- iCloud-only originals may be slow to appear the first time.

---

## Roadmap

**Stage 3 — automatic registration (needs a development build)**
OpenCV via `react-native-fast-opencv`: ORB/AKAZE features → RANSAC homography to the reference → optional ECC refinement → warped, cropped copies stored next to each capture, so the timeline swiper is pixel-aligned.

**Stage 4 — live alignment guidance**
Feature-matching the live camera frame against the reference (VisionCamera frame processor) to drive "step left 0.5 m / closer", not just angles. This is the part no existing app does.

**Stage 5 — export**
A zip per station (originals + aligned + JSON/CSV) ready for change-detection scripts. Also lens/zoom matching.

### Moving to a development build (Stage 3+)
OpenCV and VisionCamera aren't inside Expo Go, so the app needs its own build:
1. Join the Apple Developer Program (about A$149/yr).
2. Create an Expo account and log in:
   ```powershell
   npx eas-cli@latest login
   ```
3. Add the dev client and register your iPhone:
   ```powershell
   npx expo install expo-dev-client
   npx eas-cli@latest device:create
   ```
4. Build in Expo's cloud (signing is handled for you) and install the result on the phone from the link EAS gives you:
   ```powershell
   npx eas-cli@latest build --profile development --platform ios
   ```
5. From then on, `npx expo start --dev-client` works like Expo Go, but with native modules.

---

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
