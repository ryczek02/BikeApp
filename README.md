# BikeApp

A React Native mobile cycling companion app that connects to an ESP32-based bike computer via Bluetooth Low Energy. Track rides, visualize routes, and get real-time road maps — all displayed on your handlebar-mounted device.

## Features

### Bluetooth Connectivity
- Scan and connect to ESP32 bike computer over BLE
- Real-time connection status indicator (disconnected / scanning / connecting / connected)
- Bidirectional communication — control ride recording from either the phone or the device

### Live Road Map
- Fetches road geometry from OpenStreetMap via Overpass API (with redundant servers)
- Converts road data into 2D segments and streams them to the ESP32 display
- Five zoom levels: 50m, 100m, 200m, 400m, 800m
- Auto-refreshes when you move, with smart caching to minimize API calls
- Street name labels stripped of Polish diacritics for embedded display compatibility

### Route Management
- Load GPX routes from a configurable route server
- Browse and select GPX files via in-app modal
- Send route waypoints to the ESP32 for on-device visualization
- Clear active route with a single tap

### Ride Recording
- Full ride lifecycle: **Start → Pause → Resume → Stop**
- Tracks latitude, longitude, elevation, timestamp, and speed
- Export recorded rides as standard GPX files
- View ride stats: distance, duration, average speed, max speed, elevation gain

### Heading & Speed
- Continuous GPS heading tracking using the device compass
- Rotation updates sent to the ESP32 every 500ms or on >3° change
- Speed display with threshold filtering (ignores speeds below 1.0 m/s)

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | React Native 0.83 + Expo 55 |
| Language | TypeScript 5.9 |
| Bluetooth | react-native-ble-plx |
| Location | expo-location |
| Data | buffer (for BLE binary encoding) |

## Getting Started

### Prerequisites

- Node.js 18+
- Expo CLI
- iOS device or Android device with BLE support

### Installation

```bash
cd BikeApp
npm install
```

### Running

```bash
# iOS
npx expo run:ios

# Android
npx expo run:android
```

### Configuration

The route server URL is configured in `App.tsx`:

```typescript
const ROUTE_SERVER_URL = 'http://192.168.0.196:8080';
```

## BLE Protocol

The app communicates with the ESP32 using a custom binary protocol:

| Prefix | Purpose | Format |
|---|---|---|
| `MC` | Clear map buffer | — |
| `MD` | Map segment data | `x1, y1, x2, y2` (4 bytes each) |
| `MR` | Render map | — |
| `GC` | Clear GPX route | — |
| `GD` | GPX route data | `x1, y1, x2, y2` (4 bytes each) |
| `SP` | Speed update | `SP:XX.X` (km/h) |
| `SC` | Clear street names | — |
| `SN` | Street name | `SN:x,y,name` |
| `RR` | Ride state | `RR:idle\|recording\|paused` |
| `RS` | Ride stats | `RS:distance,time,avg_speed` |

## Permissions

**iOS:** Bluetooth, Location (Always & When In Use)

**Android:** Bluetooth Scan, Bluetooth Connect, Bluetooth Admin, Fine Location

## Project Structure

```
BikeApp/
├── App.tsx          # Main application (all screens & logic)
├── index.ts         # Expo entry point
├── app.json         # Expo configuration
├── package.json     # Dependencies
├── tsconfig.json    # TypeScript config
└── assets/          # App icons & splash screens
```

## License

Private project.
