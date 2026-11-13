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
| **Map** (`src/app/index.tsx`) | Indexes geotagged photos (incremental after the first scan), clusters them on a satellite map, shows stations as green diamonds. When you're within 150 m of earlier photos it zooms to them and lists them, nearest first. **＋ New station** starts a station where you're standing (the first photo becomes the reference). **? Help** shows a short how-it-works guide. |
| **Photo** | Shows date, position, GPS accuracy and camera heading read from EXIF. "Revisit this spot" creates a station with that photo as the reference. |
| **Station** | The time series. Long-press a photo to make it the alignment reference or remove it. "+ Add older photos" pulls in other camera-roll shots taken within 15–250 m. **Export station (zip)** shares everything in one file; **Log (CSV)** shares just the capture log. |
| **Navigate** | Stake-out style: north-up satellite map with an arrow at your position always pointing to the photo point, a dashed line to it, a green circle showing the GPS "on the point" radius, and a HUD with distance, bearing and N/E offsets. Below the map, a compass-relative arrow with "x m ahead · y m left". Haptic buzz when you're on the point. Pan the map to stop auto-follow; tap Re-centre to resume. |
| **Capture** | Camera framed to the ghost photo's shape. **Ghost ▾** picks which earlier photo to line up with (Original, Latest or any date; remembered per station). Ghost modes: **Blend** (opacity slider), **Edges** (outline of the old photo in a colour you choose: tap the swatch), **Split**, **Flicker**, **Off**. A guidance band shows Turn / Tilt / Rotate (and Distance) in big colour-coded boxes; the yellow ring shows where the ghost's centre is, and the bar shows the roll. A green **Lined up** banner and a buzz tell you when to shoot. **📷 Live match** (EnvRevisit build) compares the camera's video frames with the ghost several times a second and drives the guidance from the image itself, which is far more precise than the compass. The band reads **Image match (video)** when it is running on video frames; if the app can't tap the video feed it falls back to a silent still about once a second, and without a confident match to the compass and tilt sensors. A stake-out chip shows the GPS offset. **✎ Stamp** adds notes/date. After shooting, tap the thumbnail to flick between the ghost and the new photo. |
| **Timeline** | **Swipe** between dates, **Scrub** a slider that cross-fades through the whole series, or **Compare** any two dates by **Split**, **Blend**, **Flicker** or **Change**. **Aligned / As shot** switches between registered and original photos. **Export ▾** shares the current view as an image, or the whole series as a time-lapse **MP4** or **GIF** with the date (and stamp notes) on every frame. |

### Alignment markers
- On a station tap **⌖ Add markers** (or **⌖ Markers** on the camera screen) and tap up to 8 fixed features on the old photo: a rock, a fence post, a notch on the skyline. Pinch to zoom; tap a marker to remove it. Changes save as you go.
- The markers appear as numbered, coloured rings over the live camera, in every ghost mode (including **Off**), so you can put each ring on the same feature.
- Markers belong to a photo, so each ghost photo can have its own set.

### Aligning by hand with tie points
When automatic alignment fails (orange **!**) or isn't good enough:
1. Put markers on the **reference** photo (at least 2; 4 or more spread across the frame is best).
2. On the station, tap **⋯** on the photo to fix and choose **Align by hand with markers**.
3. The reference is shown as a small guide. Tap the same features, in the same order, on this photo, then **Align**.

Two markers fit shift + rotation + scale, three add shear, and four or more fit a full perspective transform. A fit that leaves the markers more than 2% of the frame apart is rejected with a message, so a mis-tapped point can't quietly produce a bad warp. Hand alignments are kept when you run **Re-align** on the station.

### Change map
**Timeline → Compare → Change** tints in magenta the places where the two dates differ, after evening out overall brightness. The slider sets how strong the tint is, and a **Change index** gives the share of the overlapping area that changed. Use aligned photos: on unaligned ones everything lights up. It responds to anything that looks different, including shadows, wet ground and moved clouds, so treat it as a pointer to where to look, not a measurement.

### Station export (zip)
**Station → Export station (zip)** builds `<Station>.zip` and opens the share sheet (Files, AirDrop, email, OneDrive):
```
<Station>/
  originals/     every photo as shot, named by date
  aligned/       the registered copies (where alignment worked)
  captures.csv   one row per photo: time, position, heading, pitch, roll, lens, notes, alignment
  station.json   station details, reference photo and markers
```

### Lenses
- The camera shows **0.5× / 1× / Tele** buttons when the phone has more than one rear lens. The lens is matched automatically to the ghost photo (from the lens recorded for in-app photos, or the focal length in a camera-roll photo's EXIF), and the lens used is stored with each new photo.

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
- **Zoom**: the three fixed lenses are supported, but not in-between digital zoom levels (e.g. a reference shot at 2× on a phone without a 2× lens).
- iCloud-only originals may be slow to appear the first time.

---

## Automatic alignment (EnvRevisit build only)
Every photo in a station is registered to the station's reference photo by a small native module in this repo (`modules/env-align`), using Apple's Vision framework (`VNHomographicImageRegistrationRequest`) and a CoreImage perspective warp into the reference frame (long side 2048 px). Originals are untouched; aligned copies live in the app's `aligned/` folder.
- New photos taken in the app are aligned automatically right after you shoot.
- **Station → Automatic alignment → Align / Re-align** processes the whole sequence (e.g. older camera-roll photos). Changing the reference re-aligns everything.
- Green ⇄ badge = aligned, orange ! = couldn't align (too different: viewpoint, season, light or lens).
- **Timeline → Aligned / As shot** switches between registered and original photos.
- If it gets one wrong, align that photo by hand with tie points (above).
- Not available in Expo Go. The rest of the app still runs there.
- Tie-point alignment, the change map, time-lapse export, zip export and video live matching were added to the native module after the first builds: an older EnvRevisit build shows "needs a new build" for them until you rebuild.

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
**Next:** "step left 0.4 m / closer" position hints from the camera feed, in-between zoom levels, app icon, change masks to ignore sky or water.

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
  markers/[id].tsx    alignment markers / tie points
  timeline/[id].tsx   swipe / scrub / compare
src/components/     UI pieces (slider, alignment guide, buttons)
src/lib/            db.ts (SQLite), library.ts (camera-roll scan + EXIF),
                    sensors.ts (GPS, compass, pitch/roll), geo.ts, storage.ts,
                    align.ts (alignment, live match, change map, time-lapse),
                    tiepoints.ts (marker fit), export.ts (station zip)
modules/env-align/  native iOS module (Vision + CoreImage + AVFoundation)
```

Checks: `npx tsc --noEmit` and `npx expo lint`.
