import React, { useState, useRef, useEffect, useCallback } from "react";
import {
  StyleSheet,
  Text,
  View,
  TextInput,
  TouchableOpacity,
  Platform,
  PermissionsAndroid,
  Alert,
  FlatList,
  StatusBar,
  ActivityIndicator,
  Modal,
  ScrollView,
} from "react-native";
import { BleManager, Device } from "react-native-ble-plx";
import * as Location from "expo-location";
import { Buffer } from "buffer";

const SERVICE_UUID = "12345678-1234-1234-1234-123456789abc";
const CHARACTERISTIC_UUID = "abcd1234-ab12-cd34-ef56-123456789abc";
const OVERPASS_SERVERS = [
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass-api.de/api/interpreter",
];
const OVERPASS_FETCH_RADIUS = 500;
const REFETCH_DISTANCE_M = 2;
const ZOOM_LEVELS = [50, 100, 200, 400, 800];
const DEFAULT_ZOOM_INDEX = 2;
const SPEED_THRESHOLD_MS = 1.0; // below this m/s → show 0

type ConnectionState = "disconnected" | "scanning" | "connecting" | "connected";
type RideState = "idle" | "recording" | "paused";

interface RoadGeometry {
  lat: number;
  lon: number;
}

interface CachedRoad {
  geometry: RoadGeometry[];
  name?: string;
}

interface Segment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

interface GpxPoint {
  lat: number;
  lon: number;
}

interface TrackPoint {
  lat: number;
  lon: number;
  ele: number;
  time: string;
  speed: number;
}

function haversineDistance(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function segmentsChanged(a: Segment[], b: Segment[]): boolean {
  if (a.length !== b.length) return true;
  for (let i = 0; i < a.length; i++) {
    if (
      a[i].x1 !== b[i].x1 ||
      a[i].y1 !== b[i].y1 ||
      a[i].x2 !== b[i].x2 ||
      a[i].y2 !== b[i].y2
    )
      return true;
  }
  return false;
}

function parseGpxPoints(gpxXml: string): GpxPoint[] {
  const points: GpxPoint[] = [];
  const regex = /<trkpt\s+lat="([^"]+)"\s+lon="([^"]+)"/g;
  let match;
  while ((match = regex.exec(gpxXml)) !== null) {
    points.push({ lat: parseFloat(match[1]), lon: parseFloat(match[2]) });
  }
  return points;
}

// Strip Polish diacritics for ESP32 display
function stripDiacritics(str: string): string {
  const map: Record<string, string> = {
    ą: "a", ć: "c", ę: "e", ł: "l", ń: "n",
    ó: "o", ś: "s", ź: "z", ż: "z",
    Ą: "A", Ć: "C", Ę: "E", Ł: "L", Ń: "N",
    Ó: "O", Ś: "S", Ź: "Z", Ż: "Z",
  };
  return str.replace(/[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/g, (c) => map[c] || c);
}

export default function App() {
  const bleManager = useRef(new BleManager()).current;
  const [connectionState, setConnectionState] =
    useState<ConnectionState>("disconnected");
  const [connectedDevice, setConnectedDevice] = useState<Device | null>(null);
  const [text, setText] = useState("");
  const [log, setLog] = useState<string[]>([]);
  const [mapActive, setMapActive] = useState(false);
  const [zoomIndex, setZoomIndex] = useState(DEFAULT_ZOOM_INDEX);

  // GPX route
  const [gpxRouteName, setGpxRouteName] = useState<string | null>(null);
  const gpxRoute = useRef<GpxPoint[]>([]);
  const lastSentGpxSegments = useRef<Segment[]>([]);

  // Route server
  const [serverUrl, setServerUrl] = useState("http://192.168.0.196:8080");
  const [routeModalVisible, setRouteModalVisible] = useState(false);
  const [routeList, setRouteList] = useState<string[]>([]);
  const [loadingRoutes, setLoadingRoutes] = useState(false);

  // Ride tracking
  const [rideState, setRideState] = useState<RideState>("idle");
  const trackPoints = useRef<TrackPoint[]>([]);
  const rideStateRef = useRef<RideState>("idle");
  const rideStartTime = useRef<number>(0);
  const ridePausedTime = useRef<number>(0);
  const ridePauseStart = useRef<number>(0);

  const cachedRoads = useRef<CachedRoad[]>([]);
  const lastFetchPos = useRef<{ lat: number; lon: number } | null>(null);
  const headingSub = useRef<Location.LocationSubscription | null>(null);
  const currentHeading = useRef<number>(0);
  const currentPos = useRef<{ lat: number; lon: number } | null>(null);
  const currentSpeed = useRef<number>(0);
  const lastSentSegments = useRef<Segment[]>([]);
  const rotationInterval = useRef<ReturnType<typeof setInterval> | null>(null);
  const positionInterval = useRef<ReturnType<typeof setInterval> | null>(null);
  const deviceRef = useRef<Device | null>(null);
  const sendingRef = useRef(false);
  const zoomRef = useRef(DEFAULT_ZOOM_INDEX);
  const forceFullSend = useRef(true);
  const lastSentHeading = useRef<number>(0);
  const lastRotationSendTime = useRef<number>(0);

  // Ref for handling BLE ride commands from ESP32
  const handleBleRideCmd = useRef<(cmd: string) => void>(() => {});
  // Ref for triggering rotation update from heading callback
  const triggerRotationUpdate = useRef<() => void>(() => {});

  useEffect(() => {
    deviceRef.current = connectedDevice;
  }, [connectedDevice]);

  useEffect(() => {
    zoomRef.current = zoomIndex;
    forceFullSend.current = true;
  }, [zoomIndex]);

  useEffect(() => {
    rideStateRef.current = rideState;
  }, [rideState]);

  useEffect(() => {
    return () => {
      headingSub.current?.remove();
      if (rotationInterval.current) clearInterval(rotationInterval.current);
      if (positionInterval.current) clearInterval(positionInterval.current);
      bleManager.destroy();
    };
  }, []);

  const addLog = useCallback((message: string) => {
    setLog((prev) => [
      `[${new Date().toLocaleTimeString()}] ${message}`,
      ...prev.slice(0, 99),
    ]);
  }, []);

  const requestPermissions = async (): Promise<boolean> => {
    if (Platform.OS === "android") {
      const apiLevel = Platform.Version as number;
      if (apiLevel >= 31) {
        const result = await PermissionsAndroid.requestMultiple([
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
          PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
        ]);
        return Object.values(result).every(
          (v) => v === PermissionsAndroid.RESULTS.GRANTED
        );
      } else {
        const result = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION
        );
        return result === PermissionsAndroid.RESULTS.GRANTED;
      }
    }
    return true;
  };

  const scanAndConnect = async () => {
    const hasPermission = await requestPermissions();
    if (!hasPermission) {
      Alert.alert("Error", "Bluetooth permissions are required");
      return;
    }

    setConnectionState("scanning");
    addLog("Scanning for BikeESP...");

    bleManager.startDeviceScan(null, null, async (error, device) => {
      if (error) {
        addLog(`Scan error: ${error.message}`);
        setConnectionState("disconnected");
        return;
      }

      if (device?.name === "BikeESP") {
        bleManager.stopDeviceScan();
        addLog("Found BikeESP! Connecting...");
        setConnectionState("connecting");

        try {
          const connected = await device.connect();
          await connected.requestMTU(512);
          await connected.discoverAllServicesAndCharacteristics();
          setConnectedDevice(connected);
          setConnectionState("connected");
          addLog("Connected to BikeESP!");

          connected.monitorCharacteristicForService(
            SERVICE_UUID,
            CHARACTERISTIC_UUID,
            (error, characteristic) => {
              if (error) return;
              if (characteristic?.value) {
                const decoded = Buffer.from(
                  characteristic.value,
                  "base64"
                ).toString("utf-8");

                // Handle ride control commands from ESP32
                if (decoded.startsWith("RC:")) {
                  handleBleRideCmd.current(decoded.substring(3));
                  return;
                }

                addLog(`ESP32: ${decoded}`);
              }
            }
          );

          connected.onDisconnected(() => {
            addLog("Disconnected from BikeESP");
            setConnectedDevice(null);
            setConnectionState("disconnected");
            stopMapUpdates();
          });
        } catch (e: any) {
          addLog(`Connection failed: ${e.message}`);
          setConnectionState("disconnected");
        }
      }
    });

    setTimeout(() => {
      bleManager.stopDeviceScan();
      setConnectionState((prev) => {
        if (prev === "scanning") {
          addLog("Scan timeout - BikeESP not found");
          return "disconnected";
        }
        return prev;
      });
    }, 10000);
  };

  const disconnect = async () => {
    stopMapUpdates();
    if (connectedDevice) {
      await connectedDevice.cancelConnection();
      setConnectedDevice(null);
      setConnectionState("disconnected");
      addLog("Disconnected");
    }
  };

  const sendText = async () => {
    if (!connectedDevice || !text.trim()) return;
    try {
      const encoded = Buffer.from(stripDiacritics(text), "utf-8").toString("base64");
      await connectedDevice.writeCharacteristicWithResponseForService(
        SERVICE_UUID,
        CHARACTERISTIC_UUID,
        encoded
      );
      addLog(`Sent: "${text}"`);
      setText("");
    } catch (e: any) {
      addLog(`Send failed: ${e.message}`);
    }
  };

  // --- BLE send helper (strips diacritics from all text) ---
  const bleSend = async (device: Device, data: string) => {
    const encoded = Buffer.from(stripDiacritics(data), "utf-8").toString("base64");
    await device.writeCharacteristicWithResponseForService(
      SERVICE_UUID,
      CHARACTERISTIC_UUID,
      encoded
    );
  };

  // --- Map / Location ---

  const fetchRoads = async (
    lat: number,
    lon: number
  ): Promise<CachedRoad[]> => {
    const query = `[out:json][timeout:10];way["highway"~"^(primary|secondary|tertiary|residential|living_street|unclassified|service)$"](around:${OVERPASS_FETCH_RADIUS},${lat},${lon});out geom tags;`;
    const encodedQuery = encodeURIComponent(query);

    for (const server of OVERPASS_SERVERS) {
      const url = `${server}?data=${encodedQuery}`;
      try {
        addLog(`Trying: ${server.split("//")[1].split("/")[0]}`);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);

        const response = await fetch(url, { signal: controller.signal });
        clearTimeout(timeout);

        const rawText = await response.text();

        if (!response.ok) {
          addLog(`HTTP ${response.status}: ${rawText.slice(0, 150)}`);
          continue;
        }

        let data: any;
        try {
          data = JSON.parse(rawText);
        } catch {
          addLog(`JSON parse fail: ${rawText.slice(0, 200)}`);
          continue;
        }

        if (!data.elements) {
          addLog(`No elements: ${JSON.stringify(data).slice(0, 150)}`);
          continue;
        }

        const roads: CachedRoad[] = [];
        for (const el of data.elements) {
          if (el.geometry) {
            roads.push({
              geometry: el.geometry.map((p: any) => ({
                lat: p.lat,
                lon: p.lon,
              })),
              name: el.tags?.name,
            });
          }
        }
        addLog(
          `OK from ${server.split("//")[1].split("/")[0]}: ${roads.length} roads`
        );
        return roads;
      } catch (e: any) {
        addLog(`Fail: ${e.name === "AbortError" ? "timeout" : e.message}`);
        continue;
      }
    }

    addLog("All Overpass servers failed");
    return [];
  };

  const projectRoads = (
    roads: CachedRoad[],
    centerLat: number,
    centerLon: number,
    headingDeg: number,
    viewRadiusM: number
  ): Segment[] => {
    const mPerLat = 111320;
    const mPerLon = 111320 * Math.cos((centerLat * Math.PI) / 180);
    const scale = 120 / viewRadiusM;
    const segments: Segment[] = [];
    const clamp = (v: number) => Math.max(1, Math.min(238, Math.round(v)));

    const rad = (-headingDeg * Math.PI) / 180;
    const cosR = Math.cos(rad);
    const sinR = Math.sin(rad);

    const project = (lat: number, lon: number) => {
      const mx = (lon - centerLon) * mPerLon * scale;
      const my = -(lat - centerLat) * mPerLat * scale;
      const rx = mx * cosR - my * sinR + 120;
      const ry = mx * sinR + my * cosR + 120;
      return { x: rx, y: ry };
    };

    for (const road of roads) {
      for (let i = 0; i < road.geometry.length - 1; i++) {
        const p1 = project(road.geometry[i].lat, road.geometry[i].lon);
        const p2 = project(road.geometry[i + 1].lat, road.geometry[i + 1].lon);

        if (
          (p1.x < 0 && p2.x < 0) ||
          (p1.x > 239 && p2.x > 239) ||
          (p1.y < 0 && p2.y < 0) ||
          (p1.y > 239 && p2.y > 239)
        )
          continue;

        segments.push({
          x1: clamp(p1.x),
          y1: clamp(p1.y),
          x2: clamp(p2.x),
          y2: clamp(p2.y),
        });
      }
    }

    return segments.slice(0, 120);
  };

  const projectGpxRoute = (
    points: GpxPoint[],
    centerLat: number,
    centerLon: number,
    headingDeg: number,
    viewRadiusM: number
  ): Segment[] => {
    const mPerLat = 111320;
    const mPerLon = 111320 * Math.cos((centerLat * Math.PI) / 180);
    const scale = 120 / viewRadiusM;
    const segments: Segment[] = [];
    const clamp = (v: number) => Math.max(1, Math.min(238, Math.round(v)));

    const rad = (-headingDeg * Math.PI) / 180;
    const cosR = Math.cos(rad);
    const sinR = Math.sin(rad);

    const project = (lat: number, lon: number) => {
      const mx = (lon - centerLon) * mPerLon * scale;
      const my = -(lat - centerLat) * mPerLat * scale;
      const rx = mx * cosR - my * sinR + 120;
      const ry = mx * sinR + my * cosR + 120;
      return { x: rx, y: ry };
    };

    for (let i = 0; i < points.length - 1; i++) {
      const p1 = project(points[i].lat, points[i].lon);
      const p2 = project(points[i + 1].lat, points[i + 1].lon);

      if (
        (p1.x < 0 && p2.x < 0) ||
        (p1.x > 239 && p2.x > 239) ||
        (p1.y < 0 && p2.y < 0) ||
        (p1.y > 239 && p2.y > 239)
      )
        continue;

      segments.push({
        x1: clamp(p1.x),
        y1: clamp(p1.y),
        x2: clamp(p2.x),
        y2: clamp(p2.y),
      });
    }

    return segments.slice(0, 120);
  };

  const sendFullMap = async (device: Device, segments: Segment[]) => {
    const clearCmd = Buffer.from("MC").toString("base64");
    await device.writeCharacteristicWithResponseForService(
      SERVICE_UUID,
      CHARACTERISTIC_UUID,
      clearCmd
    );

    const CHUNK_SIZE = 60;
    for (let i = 0; i < segments.length; i += CHUNK_SIZE) {
      const chunk = segments.slice(i, i + CHUNK_SIZE);
      const buf = Buffer.alloc(2 + chunk.length * 4);
      buf[0] = 0x4d; // 'M'
      buf[1] = 0x44; // 'D'
      for (let j = 0; j < chunk.length; j++) {
        buf[2 + j * 4] = chunk[j].x1;
        buf[2 + j * 4 + 1] = chunk[j].y1;
        buf[2 + j * 4 + 2] = chunk[j].x2;
        buf[2 + j * 4 + 3] = chunk[j].y2;
      }
      await device.writeCharacteristicWithResponseForService(
        SERVICE_UUID,
        CHARACTERISTIC_UUID,
        buf.toString("base64")
      );
    }

    // MR render command moved to sendRotationUpdate (after GPX data)
  };

  const sendGpxToDevice = async (device: Device, segments: Segment[]) => {
    const clearCmd = Buffer.from("GC").toString("base64");
    await device.writeCharacteristicWithResponseForService(
      SERVICE_UUID,
      CHARACTERISTIC_UUID,
      clearCmd
    );

    const CHUNK_SIZE = 60;
    for (let i = 0; i < segments.length; i += CHUNK_SIZE) {
      const chunk = segments.slice(i, i + CHUNK_SIZE);
      const buf = Buffer.alloc(2 + chunk.length * 4);
      buf[0] = 0x47; // 'G'
      buf[1] = 0x44; // 'D'
      for (let j = 0; j < chunk.length; j++) {
        buf[2 + j * 4] = chunk[j].x1;
        buf[2 + j * 4 + 1] = chunk[j].y1;
        buf[2 + j * 4 + 2] = chunk[j].x2;
        buf[2 + j * 4 + 3] = chunk[j].y2;
      }
      await device.writeCharacteristicWithResponseForService(
        SERVICE_UUID,
        CHARACTERISTIC_UUID,
        buf.toString("base64")
      );
    }

    // No GR render command — MR will trigger render for both map+gpx
  };

  const sendStreetNames = async (
    device: Device,
    roads: CachedRoad[],
    centerLat: number,
    centerLon: number,
    headingDeg: number,
    viewRadiusM: number
  ) => {
    const mPerLat = 111320;
    const mPerLon = 111320 * Math.cos((centerLat * Math.PI) / 180);
    const scale = 120 / viewRadiusM;
    const rad = (-headingDeg * Math.PI) / 180;
    const cosR = Math.cos(rad);
    const sinR = Math.sin(rad);

    const project = (lat: number, lon: number) => {
      const mx = (lon - centerLon) * mPerLon * scale;
      const my = -(lat - centerLat) * mPerLat * scale;
      return {
        x: mx * cosR - my * sinR + 120,
        y: mx * sinR + my * cosR + 120,
      };
    };

    await bleSend(device, "SC");

    const seen = new Set<string>();
    let sent = 0;
    for (const road of roads) {
      if (!road.name || seen.has(road.name) || sent >= 8) continue;

      const midIdx = Math.floor(road.geometry.length / 2);
      const mid = project(road.geometry[midIdx].lat, road.geometry[midIdx].lon);

      if (mid.x < 5 || mid.x > 235 || mid.y < 5 || mid.y > 235) continue;

      seen.add(road.name);
      const cleanName = stripDiacritics(road.name).substring(0, 31);
      await bleSend(
        device,
        `SN:${Math.round(mid.x)},${Math.round(mid.y)},${cleanName}`
      );
      sent++;
    }
  };

  const sendMapToDevice = async (device: Device, segments: Segment[]) => {
    try {
      const changed =
        forceFullSend.current ||
        segmentsChanged(segments, lastSentSegments.current);
      if (!changed) return;

      forceFullSend.current = false;
      lastSentSegments.current = segments;
      await sendFullMap(device, segments);
    } catch (e: any) {
      addLog(`Map send error: ${e.message}`);
    }
  };

  // --- Ride stats computation ---
  const computeRideStats = () => {
    const pts = trackPoints.current;
    if (pts.length < 2) return { dist: 0, time: "0:00", avg: 0 };

    let dist = 0;
    for (let i = 1; i < pts.length; i++) {
      dist += haversineDistance(
        pts[i - 1].lat,
        pts[i - 1].lon,
        pts[i].lat,
        pts[i].lon
      );
    }

    const now = Date.now();
    const totalPaused = ridePausedTime.current +
      (rideStateRef.current === "paused" ? now - ridePauseStart.current : 0);
    const elapsedMs = now - rideStartTime.current - totalPaused;
    const elapsedS = Math.max(0, Math.floor(elapsedMs / 1000));
    const hours = Math.floor(elapsedS / 3600);
    const mins = Math.floor((elapsedS % 3600) / 60);
    const secs = elapsedS % 60;
    const timeStr =
      hours > 0
        ? `${hours}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`
        : `${mins}:${String(secs).padStart(2, "0")}`;

    const distKm = dist / 1000;
    const elapsedHours = elapsedMs / 3600000;
    const avg = elapsedHours > 0.001 ? distKm / elapsedHours : 0;

    return { dist: distKm, time: timeStr, avg };
  };

  const sendRotationUpdate = async () => {
    const device = deviceRef.current;
    const pos = currentPos.current;
    if (
      !device ||
      !pos ||
      cachedRoads.current.length === 0 ||
      sendingRef.current
    )
      return;

    sendingRef.current = true;
    try {
      const viewRadius = ZOOM_LEVELS[zoomRef.current];
      const segments = projectRoads(
        cachedRoads.current,
        pos.lat,
        pos.lon,
        currentHeading.current,
        viewRadius
      );
      await sendMapToDevice(device, segments);

      // Send speed (with threshold)
      const rawSpeed = currentSpeed.current;
      const speedKmh =
        rawSpeed < SPEED_THRESHOLD_MS ? "0.0" : (rawSpeed * 3.6).toFixed(1);
      await bleSend(device, `SP:${speedKmh}`);

      // Send GPX route if loaded (before MR render)
      if (gpxRoute.current.length > 0) {
        const gpxSegments = projectGpxRoute(
          gpxRoute.current,
          pos.lat,
          pos.lon,
          currentHeading.current,
          viewRadius
        );
        const gpxChanged = segmentsChanged(
          gpxSegments,
          lastSentGpxSegments.current
        );
        if (gpxChanged) {
          lastSentGpxSegments.current = gpxSegments;
          await sendGpxToDevice(device, gpxSegments);
        }
      }

      // MR — trigger render for both map + GPX in sync
      const renderCmd = Buffer.from("MR").toString("base64");
      await device.writeCharacteristicWithResponseForService(
        SERVICE_UUID,
        CHARACTERISTIC_UUID,
        renderCmd
      );

      // Send street names
      await sendStreetNames(
        device,
        cachedRoads.current,
        pos.lat,
        pos.lon,
        currentHeading.current,
        viewRadius
      );

      // Send ride stats if recording or paused
      if (
        rideStateRef.current === "recording" ||
        rideStateRef.current === "paused"
      ) {
        const stats = computeRideStats();
        await bleSend(
          device,
          `RS:${stats.dist.toFixed(1)},${stats.time},${stats.avg.toFixed(0)}`
        );
      }
      lastSentHeading.current = currentHeading.current;
      lastRotationSendTime.current = Date.now();
    } finally {
      sendingRef.current = false;
    }
  };

  // Wire up heading-driven rotation trigger
  triggerRotationUpdate.current = () => {
    const now = Date.now();
    // Throttle: minimum 500ms between sends
    if (now - lastRotationSendTime.current < 500) return;
    // Only trigger if heading changed > 3 degrees
    let diff = Math.abs(currentHeading.current - lastSentHeading.current);
    if (diff > 180) diff = 360 - diff;
    if (diff < 3) return;
    sendRotationUpdate();
  };

  const sendPositionUpdate = async () => {
    const device = deviceRef.current;
    if (!device) return;

    try {
      const location = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.High,
      });
      const { latitude, longitude, altitude, speed } = location.coords;
      currentPos.current = { lat: latitude, lon: longitude };
      currentSpeed.current = Math.max(0, speed ?? 0);

      // Ride tracking
      if (rideStateRef.current === "recording") {
        trackPoints.current.push({
          lat: latitude,
          lon: longitude,
          ele: altitude ?? 0,
          time: new Date().toISOString(),
          speed: Math.max(0, speed ?? 0),
        });
      }

      const needFetch =
        !lastFetchPos.current ||
        haversineDistance(
          lastFetchPos.current.lat,
          lastFetchPos.current.lon,
          latitude,
          longitude
        ) > REFETCH_DISTANCE_M;

      if (needFetch) {
        addLog(
          `Fetching roads near ${latitude.toFixed(4)}, ${longitude.toFixed(4)}`
        );
        cachedRoads.current = await fetchRoads(latitude, longitude);
        lastFetchPos.current = { lat: latitude, lon: longitude };
        addLog(`Got ${cachedRoads.current.length} roads`);
        forceFullSend.current = true;
      }

      await sendRotationUpdate();
    } catch (e: any) {
      addLog(`Position error: ${e.message}`);
    }
  };

  const startMapUpdates = async () => {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== "granted") {
      Alert.alert("Error", "Location permission is required for map");
      return;
    }

    setMapActive(true);
    addLog(`Map started (zoom ${ZOOM_LEVELS[zoomIndex]}m)`);

    headingSub.current = await Location.watchHeadingAsync((heading) => {
      currentHeading.current = heading.trueHeading ?? heading.magHeading ?? 0;
      // Trigger near-realtime rotation on significant heading change
      triggerRotationUpdate.current();
    });

    await sendPositionUpdate();

    // Fallback rotation every 3s (in case heading doesn't change)
    rotationInterval.current = setInterval(sendRotationUpdate, 3000);
    const posInterval = rideStateRef.current === "recording" ? 3000 : 10000;
    positionInterval.current = setInterval(sendPositionUpdate, posInterval);
  };

  const stopMapUpdates = () => {
    headingSub.current?.remove();
    headingSub.current = null;
    if (rotationInterval.current) {
      clearInterval(rotationInterval.current);
      rotationInterval.current = null;
    }
    if (positionInterval.current) {
      clearInterval(positionInterval.current);
      positionInterval.current = null;
    }
    sendingRef.current = false;
    setMapActive(false);
    lastFetchPos.current = null;
    currentPos.current = null;
    cachedRoads.current = [];
    lastSentSegments.current = [];
    lastSentGpxSegments.current = [];
    forceFullSend.current = true;
  };

  // --- Ride tracking ---

  const sendRideState = async (state: RideState) => {
    const device = deviceRef.current;
    if (device) {
      try {
        await bleSend(device, `RR:${state}`);
      } catch {}
    }
  };

  const startRide = () => {
    trackPoints.current = [];
    rideStartTime.current = Date.now();
    ridePausedTime.current = 0;
    setRideState("recording");
    sendRideState("recording");
    addLog("Ride recording started");
    if (positionInterval.current) {
      clearInterval(positionInterval.current);
      positionInterval.current = setInterval(sendPositionUpdate, 3000);
    }
  };

  const pauseRide = () => {
    ridePauseStart.current = Date.now();
    setRideState("paused");
    sendRideState("paused");
    addLog("Ride paused");
  };

  const resumeRide = () => {
    ridePausedTime.current += Date.now() - ridePauseStart.current;
    setRideState("recording");
    sendRideState("recording");
    addLog("Ride resumed");
  };

  const stopRide = () => {
    const pts = trackPoints.current;
    Alert.alert("Stop Ride", `${pts.length} points recorded`, [
      {
        text: "Export GPX",
        onPress: () => exportRideGpx(),
      },
      {
        text: "Discard",
        style: "destructive",
        onPress: () => {
          trackPoints.current = [];
          setRideState("idle");
          sendRideState("idle");
          addLog("Ride discarded");
          if (positionInterval.current) {
            clearInterval(positionInterval.current);
            positionInterval.current = setInterval(sendPositionUpdate, 10000);
          }
        },
      },
      { text: "Cancel" },
    ]);
  };

  // Stop ride from ESP32 button — auto-export, no dialog
  const stopRideFromEsp = () => {
    addLog("Ride stopped from ESP32");
    exportRideGpx();
  };

  const exportRideGpx = async () => {
    const points = trackPoints.current;
    if (points.length === 0) {
      addLog("No points to export");
      setRideState("idle");
      sendRideState("idle");
      return;
    }

    const gpxXml = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="BikeApp"
  xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>Bike Ride ${new Date().toLocaleDateString()}</name>
    <trkseg>
${points
  .map(
    (p) =>
      `      <trkpt lat="${p.lat}" lon="${p.lon}">
        <ele>${p.ele.toFixed(1)}</ele>
        <time>${p.time}</time>
        <extensions><speed>${p.speed.toFixed(2)}</speed></extensions>
      </trkpt>`
  )
  .join("\n")}
    </trkseg>
  </trk>
</gpx>`;

    const filename = `ride_${Date.now()}.gpx`;
    try {
      const response = await fetch(`${serverUrl}/upload`, {
        method: "POST",
        headers: {
          "Content-Type": "application/gpx+xml",
          "X-Filename": filename,
        },
        body: gpxXml,
      });
      const result = await response.json();
      addLog(`Uploaded: ${result.filename} (${points.length} pts)`);
    } catch (e: any) {
      addLog(`Upload error: ${e.message}`);
    }

    trackPoints.current = [];
    setRideState("idle");
    sendRideState("idle");
    if (positionInterval.current) {
      clearInterval(positionInterval.current);
      positionInterval.current = setInterval(sendPositionUpdate, 10000);
    }
  };

  // Wire up BLE ride command handler (uses refs so always fresh)
  handleBleRideCmd.current = (cmd: string) => {
    if (cmd === "START") startRide();
    else if (cmd === "PAUSE") pauseRide();
    else if (cmd === "RESUME") resumeRide();
    else if (cmd === "STOP") stopRideFromEsp();
  };

  // --- Route server ---

  const fetchRouteList = async () => {
    setLoadingRoutes(true);
    try {
      const response = await fetch(`${serverUrl}/gpx`);
      const files: string[] = await response.json();
      setRouteList(files);
      setRouteModalVisible(true);
    } catch (e: any) {
      Alert.alert("Error", `Cannot reach server: ${e.message}`);
    }
    setLoadingRoutes(false);
  };

  const loadRoute = async (filename: string) => {
    try {
      const response = await fetch(`${serverUrl}/gpx/${filename}`);
      const gpxXml = await response.text();
      const points = parseGpxPoints(gpxXml);
      gpxRoute.current = points;
      lastSentGpxSegments.current = [];
      setGpxRouteName(filename);
      setRouteModalVisible(false);
      forceFullSend.current = true;
      addLog(`Loaded route: ${filename} (${points.length} points)`);
    } catch (e: any) {
      addLog(`Route load error: ${e.message}`);
    }
  };

  const clearRoute = () => {
    gpxRoute.current = [];
    lastSentGpxSegments.current = [];
    setGpxRouteName(null);
    forceFullSend.current = true;
    addLog("Route cleared");
  };

  const zoomIn = () => {
    setZoomIndex((prev) => Math.max(0, prev - 1));
    addLog(`Zoom: ${ZOOM_LEVELS[Math.max(0, zoomIndex - 1)]}m`);
  };

  const zoomOut = () => {
    setZoomIndex((prev) => Math.min(ZOOM_LEVELS.length - 1, prev + 1));
    addLog(
      `Zoom: ${ZOOM_LEVELS[Math.min(ZOOM_LEVELS.length - 1, zoomIndex + 1)]}m`
    );
  };

  const getStatusColor = () => {
    switch (connectionState) {
      case "connected":
        return "#4CAF50";
      case "scanning":
      case "connecting":
        return "#FF9800";
      default:
        return "#F44336";
    }
  };

  const getStatusText = () => {
    switch (connectionState) {
      case "connected":
        return "Connected";
      case "scanning":
        return "Scanning...";
      case "connecting":
        return "Connecting...";
      default:
        return "Disconnected";
    }
  };

  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" />

      <View style={styles.header}>
        <Text style={styles.title}>BikeESP Remote</Text>
        <View style={styles.statusRow}>
          <View
            style={[styles.statusDot, { backgroundColor: getStatusColor() }]}
          />
          <Text style={styles.statusText}>{getStatusText()}</Text>
        </View>
      </View>

      {/* Connection */}
      <View style={styles.section}>
        {connectionState === "disconnected" ? (
          <TouchableOpacity style={styles.connectBtn} onPress={scanAndConnect}>
            <Text style={styles.btnText}>Connect to BikeESP</Text>
          </TouchableOpacity>
        ) : connectionState === "connected" ? (
          <TouchableOpacity style={styles.disconnectBtn} onPress={disconnect}>
            <Text style={styles.btnText}>Disconnect</Text>
          </TouchableOpacity>
        ) : (
          <View style={styles.scanningRow}>
            <ActivityIndicator color="#fff" />
            <Text style={styles.scanningText}>{getStatusText()}</Text>
          </View>
        )}
      </View>

      {/* Send Text */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Send to Display</Text>
        <View style={styles.inputRow}>
          <TextInput
            style={styles.input}
            value={text}
            onChangeText={setText}
            placeholder="Type message..."
            placeholderTextColor="#666"
            editable={connectionState === "connected"}
          />
          <TouchableOpacity
            style={[
              styles.sendBtn,
              connectionState !== "connected" && styles.btnDisabled,
            ]}
            onPress={sendText}
            disabled={connectionState !== "connected" || !text.trim()}
          >
            <Text style={styles.btnText}>Send</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Map Controls */}
      <View style={styles.section}>
        <View style={styles.mapRow}>
          <TouchableOpacity
            style={[
              mapActive ? styles.stopMapBtn : styles.mapBtn,
              connectionState !== "connected" && styles.btnDisabled,
            ]}
            onPress={mapActive ? stopMapUpdates : startMapUpdates}
            disabled={connectionState !== "connected"}
          >
            <Text style={styles.btnText}>
              {mapActive ? "Stop Map" : "Start Map"}
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.zoomBtn, !mapActive && styles.btnDisabled]}
            onPress={zoomIn}
            disabled={!mapActive || zoomIndex === 0}
          >
            <Text style={styles.zoomBtnText}>+</Text>
          </TouchableOpacity>

          <Text style={styles.zoomLabel}>{ZOOM_LEVELS[zoomIndex]}m</Text>

          <TouchableOpacity
            style={[styles.zoomBtn, !mapActive && styles.btnDisabled]}
            onPress={zoomOut}
            disabled={!mapActive || zoomIndex === ZOOM_LEVELS.length - 1}
          >
            <Text style={styles.zoomBtnText}>-</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* GPX Routes */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>GPX Route</Text>
        <View style={styles.inputRow}>
          <TextInput
            style={[styles.input, { flex: 2 }]}
            value={serverUrl}
            onChangeText={setServerUrl}
            placeholder="Server URL"
            placeholderTextColor="#666"
          />
          <TouchableOpacity
            style={styles.sendBtn}
            onPress={fetchRouteList}
            disabled={loadingRoutes}
          >
            <Text style={styles.btnText}>
              {loadingRoutes ? "..." : "Routes"}
            </Text>
          </TouchableOpacity>
        </View>
        {gpxRouteName && (
          <View style={styles.routeActiveRow}>
            <Text style={styles.routeActiveText}>{gpxRouteName}</Text>
            <TouchableOpacity onPress={clearRoute}>
              <Text style={styles.routeClearText}>X</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>

      {/* Ride Tracking */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>
          Ride{" "}
          {rideState !== "idle" && (
            <Text style={{ color: rideState === "recording" ? "#4CAF50" : "#FF9800" }}>
              {rideState === "recording" ? "REC" : "PAUSED"}
            </Text>
          )}
        </Text>
        <View style={styles.mapRow}>
          {rideState === "idle" ? (
            <TouchableOpacity
              style={[
                styles.mapBtn,
                { backgroundColor: "#4CAF50" },
                !mapActive && styles.btnDisabled,
              ]}
              onPress={startRide}
              disabled={!mapActive}
            >
              <Text style={styles.btnText}>Start Ride</Text>
            </TouchableOpacity>
          ) : (
            <>
              {rideState === "recording" ? (
                <TouchableOpacity
                  style={[styles.mapBtn, { backgroundColor: "#FF9800" }]}
                  onPress={pauseRide}
                >
                  <Text style={styles.btnText}>Pause</Text>
                </TouchableOpacity>
              ) : (
                <TouchableOpacity
                  style={[styles.mapBtn, { backgroundColor: "#4CAF50" }]}
                  onPress={resumeRide}
                >
                  <Text style={styles.btnText}>Resume</Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity
                style={[
                  styles.mapBtn,
                  { backgroundColor: "#F44336", flex: 0.5 },
                ]}
                onPress={stopRide}
              >
                <Text style={styles.btnText}>Stop</Text>
              </TouchableOpacity>
            </>
          )}
        </View>
      </View>

      {/* Log */}
      <View style={styles.logSection}>
        <Text style={styles.sectionTitle}>Log</Text>
        <FlatList
          data={log}
          keyExtractor={(_, i) => i.toString()}
          renderItem={({ item }) => <Text style={styles.logItem}>{item}</Text>}
          style={styles.logList}
        />
      </View>

      {/* Route selection modal */}
      <Modal
        visible={routeModalVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setRouteModalVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Select Route</Text>
              <TouchableOpacity onPress={() => setRouteModalVisible(false)}>
                <Text style={styles.routeClearText}>X</Text>
              </TouchableOpacity>
            </View>
            <ScrollView>
              {routeList.length === 0 ? (
                <Text style={styles.modalEmpty}>
                  No .gpx files found in routes/
                </Text>
              ) : (
                routeList.map((file) => (
                  <TouchableOpacity
                    key={file}
                    style={styles.routeItem}
                    onPress={() => loadRoute(file)}
                  >
                    <Text style={styles.routeItemText}>{file}</Text>
                  </TouchableOpacity>
                ))
              )}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#1a1a2e",
    paddingTop: Platform.OS === "ios" ? 60 : 40,
  },
  header: {
    paddingHorizontal: 20,
    marginBottom: 12,
  },
  title: {
    fontSize: 28,
    fontWeight: "bold",
    color: "#fff",
  },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: 8,
  },
  statusDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginRight: 8,
  },
  statusText: {
    color: "#aaa",
    fontSize: 14,
  },
  section: {
    paddingHorizontal: 20,
    marginBottom: 12,
  },
  sectionTitle: {
    color: "#aaa",
    fontSize: 12,
    textTransform: "uppercase",
    letterSpacing: 1,
    marginBottom: 8,
  },
  connectBtn: {
    backgroundColor: "#4CAF50",
    padding: 16,
    borderRadius: 12,
    alignItems: "center",
  },
  disconnectBtn: {
    backgroundColor: "#F44336",
    padding: 16,
    borderRadius: 12,
    alignItems: "center",
  },
  mapRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  mapBtn: {
    flex: 1,
    backgroundColor: "#2196F3",
    padding: 14,
    borderRadius: 12,
    alignItems: "center",
  },
  stopMapBtn: {
    flex: 1,
    backgroundColor: "#FF9800",
    padding: 14,
    borderRadius: 12,
    alignItems: "center",
  },
  zoomBtn: {
    backgroundColor: "#16213e",
    width: 44,
    height: 44,
    borderRadius: 12,
    justifyContent: "center",
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#2a2a4a",
  },
  zoomBtnText: {
    color: "#fff",
    fontSize: 22,
    fontWeight: "bold",
  },
  zoomLabel: {
    color: "#aaa",
    fontSize: 14,
    minWidth: 45,
    textAlign: "center",
  },
  btnText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "600",
  },
  btnDisabled: {
    opacity: 0.4,
  },
  scanningRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    padding: 16,
    backgroundColor: "#16213e",
    borderRadius: 12,
  },
  scanningText: {
    color: "#FF9800",
    fontSize: 16,
    marginLeft: 10,
  },
  inputRow: {
    flexDirection: "row",
    gap: 10,
  },
  input: {
    flex: 1,
    backgroundColor: "#16213e",
    color: "#fff",
    padding: 14,
    borderRadius: 12,
    fontSize: 16,
    borderWidth: 1,
    borderColor: "#2a2a4a",
  },
  sendBtn: {
    backgroundColor: "#0f3460",
    paddingHorizontal: 24,
    borderRadius: 12,
    justifyContent: "center",
    alignItems: "center",
  },
  routeActiveRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 8,
    backgroundColor: "#16213e",
    padding: 10,
    borderRadius: 8,
  },
  routeActiveText: {
    color: "#FF4444",
    fontSize: 14,
    fontWeight: "600",
  },
  routeClearText: {
    color: "#FF4444",
    fontSize: 18,
    fontWeight: "bold",
    paddingHorizontal: 8,
  },
  logSection: {
    flex: 1,
    paddingHorizontal: 20,
  },
  logList: {
    backgroundColor: "#16213e",
    borderRadius: 12,
    padding: 12,
  },
  logItem: {
    color: "#7ec8e3",
    fontSize: 12,
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    marginBottom: 4,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.7)",
    justifyContent: "center",
    padding: 30,
  },
  modalContent: {
    backgroundColor: "#1a1a2e",
    borderRadius: 16,
    padding: 20,
    maxHeight: 400,
    borderWidth: 1,
    borderColor: "#2a2a4a",
  },
  modalHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 16,
  },
  modalTitle: {
    color: "#fff",
    fontSize: 20,
    fontWeight: "bold",
  },
  modalEmpty: {
    color: "#666",
    textAlign: "center",
    padding: 20,
  },
  routeItem: {
    padding: 14,
    borderBottomWidth: 1,
    borderBottomColor: "#2a2a4a",
  },
  routeItemText: {
    color: "#7ec8e3",
    fontSize: 16,
  },
});
