package de.stephan.evchargelive;

import android.Manifest;
import android.annotation.SuppressLint;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothSocket;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.ParcelUuid;

import androidx.core.app.ActivityCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@CapacitorPlugin(
    name = "ObdClassic",
    permissions = {
        @Permission(
            alias = "bluetooth_connect",
            strings = { Manifest.permission.BLUETOOTH_CONNECT }
        ),
        @Permission(
            alias = "bluetooth_scan",
            strings = { Manifest.permission.BLUETOOTH_SCAN }
        ),
        @Permission(
            alias = "bluetooth_legacy",
            strings = {
                Manifest.permission.BLUETOOTH,
                Manifest.permission.BLUETOOTH_ADMIN
            }
        )
    }
)
public class ObdClassicPlugin extends Plugin {

    private static final UUID SPP_UUID = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB");

    private final ExecutorService ioExecutor = Executors.newSingleThreadExecutor();
    private volatile BluetoothSocket activeSocket = null;
    private volatile InputStream activeInput = null;
    private volatile OutputStream activeOutput = null;
    private volatile Thread readerThread = null;
    private volatile boolean readerRunning = false;
    private volatile String connectedAddress = null;

    private void emitDebug(String level, String message) {
        JSObject obj = new JSObject();
        obj.put("level", level);
        obj.put("message", message);
        obj.put("timestamp", System.currentTimeMillis());
        notifyListeners("obdDebug", obj);
    }

    private BluetoothAdapter getBtAdapter() {
        Context ctx = getContext();
        if (ctx == null) return BluetoothAdapter.getDefaultAdapter();
        BluetoothManager bm = (BluetoothManager) ctx.getSystemService(Context.BLUETOOTH_SERVICE);
        if (bm != null && bm.getAdapter() != null) {
            return bm.getAdapter();
        }
        return BluetoothAdapter.getDefaultAdapter();
    }

    private boolean hasBtConnectPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            Context ctx = getContext();
            if (ctx == null) return false;
            return ActivityCompat.checkSelfPermission(ctx, Manifest.permission.BLUETOOTH_CONNECT)
                == PackageManager.PERMISSION_GRANTED;
        }
        return true;
    }

    @PluginMethod
    public void ensurePermissions(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && !hasBtConnectPermission()) {
            emitDebug("info", "Fordere Android 12+ BLUETOOTH_CONNECT & BLUETOOTH_SCAN Berechtigung an...");
            requestPermissionForAliases(
                new String[]{ "bluetooth_connect", "bluetooth_scan" },
                call,
                "permissionsCallback"
            );
            return;
        }
        BluetoothAdapter adapter = getBtAdapter();
        JSObject ret = new JSObject();
        ret.put("granted", true);
        ret.put("sdkInt", Build.VERSION.SDK_INT);
        ret.put("bluetoothEnabled", adapter != null && adapter.isEnabled());
        call.resolve(ret);
    }

    @PermissionCallback
    private void permissionsCallback(PluginCall call) {
        boolean granted = hasBtConnectPermission();
        BluetoothAdapter adapter = getBtAdapter();
        JSObject ret = new JSObject();
        ret.put("granted", granted);
        ret.put("sdkInt", Build.VERSION.SDK_INT);
        ret.put("bluetoothEnabled", adapter != null && adapter.isEnabled());
        emitDebug(granted ? "success" : "error", "Bluetooth-Berechtigung: " + (granted ? "ERTEILT" : "VERWEIGERT"));
        if ("getBondedDevices".equals(call.getMethodName())) {
            if (granted) {
                getBondedDevicesInternal(call);
            } else {
                call.reject("BLUETOOTH_CONNECT Berechtigung wurde verweigert.");
            }
        } else {
            call.resolve(ret);
        }
    }

    @PluginMethod
    public void getBondedDevices(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && !hasBtConnectPermission()) {
            requestPermissionForAliases(
                new String[]{ "bluetooth_connect", "bluetooth_scan" },
                call,
                "permissionsCallback"
            );
            return;
        }
        getBondedDevicesInternal(call);
    }

    @SuppressLint("MissingPermission")
    private void getBondedDevicesInternal(PluginCall call) {
        BluetoothAdapter adapter = getBtAdapter();
        if (adapter == null) {
            call.reject("Kein Bluetooth-Adapter auf diesem Gerät verfügbar.");
            return;
        }

        JSArray devicesArr = new JSArray();
        Set<BluetoothDevice> bonded = adapter.getBondedDevices();
        if (bonded != null) {
            for (BluetoothDevice dev : bonded) {
                JSObject d = new JSObject();
                String name = dev.getName();
                String addr = dev.getAddress();
                int typeCode = dev.getType();
                String typeStr = "UNKNOWN";
                if (typeCode == BluetoothDevice.DEVICE_TYPE_CLASSIC) typeStr = "CLASSIC";
                else if (typeCode == BluetoothDevice.DEVICE_TYPE_LE) typeStr = "BLE";
                else if (typeCode == BluetoothDevice.DEVICE_TYPE_DUAL) typeStr = "DUAL";

                JSArray uuidArr = new JSArray();
                boolean hasSppUuid = false;
                ParcelUuid[] uuids = dev.getUuids();
                if (uuids != null) {
                    for (ParcelUuid pu : uuids) {
                        if (pu != null && pu.getUuid() != null) {
                            String uStr = pu.getUuid().toString().toLowerCase();
                            uuidArr.put(uStr);
                            if (uStr.startsWith("00001101")) {
                                hasSppUuid = true;
                            }
                        }
                    }
                }

                d.put("name", name != null ? name : "Unbekanntes Gerät");
                d.put("address", addr);
                d.put("deviceId", addr);
                d.put("typeCode", typeCode);
                d.put("type", typeStr);
                d.put("bondState", dev.getBondState());
                d.put("uuids", uuidArr);
                d.put("supportsSpp", hasSppUuid || typeCode == BluetoothDevice.DEVICE_TYPE_CLASSIC || typeCode == BluetoothDevice.DEVICE_TYPE_DUAL);
                devicesArr.put(d);
            }
        }

        JSObject ret = new JSObject();
        ret.put("enabled", adapter.isEnabled());
        ret.put("sdkInt", Build.VERSION.SDK_INT);
        ret.put("count", devicesArr.length());
        ret.put("devices", devicesArr);
        call.resolve(ret);
    }

    @SuppressLint("MissingPermission")
    @PluginMethod
    public void connectSpp(PluginCall call) {
        if (!hasBtConnectPermission()) {
            call.reject("Fehlende BLUETOOTH_CONNECT Berechtigung.");
            return;
        }

        final String address = call.getString("address", null);
        final String requestedStrategy = call.getString("strategy", "auto");
        if (address == null || address.trim().isEmpty()) {
            call.reject("Keine Bluetooth MAC-Adresse angegeben.");
            return;
        }

        final BluetoothAdapter adapter = getBtAdapter();
        if (adapter == null || !adapter.isEnabled()) {
            call.reject("Bluetooth ist ausgeschaltet.");
            return;
        }

        ioExecutor.execute(() -> {
            closeActiveSocketInternal();

            try {
                BluetoothDevice device = adapter.getRemoteDevice(address.trim().toUpperCase());
                String devName = device.getName() != null ? device.getName() : address;
                emitDebug("info", "Zielgerät: " + devName + " [" + address + "], Typ=" + device.getType() + ", BondState=" + device.getBondState());

                if (adapter.isDiscovering()) {
                    emitDebug("info", "Stoppe laufende Bluetooth-Suche (cancelDiscovery)...");
                    adapter.cancelDiscovery();
                    try { Thread.sleep(200); } catch (InterruptedException ignored) {}
                }

                String[] strategies;
                if ("secure".equalsIgnoreCase(requestedStrategy)) {
                    strategies = new String[]{ "secure" };
                } else if ("insecure".equalsIgnoreCase(requestedStrategy)) {
                    strategies = new String[]{ "insecure" };
                } else if ("reflection".equalsIgnoreCase(requestedStrategy)) {
                    strategies = new String[]{ "reflection_ch1", "insecure_reflection_ch1" };
                } else {
                    strategies = new String[]{ "secure", "insecure", "reflection_ch1", "insecure_reflection_ch1" };
                }

                BluetoothSocket connectedSock = null;
                String winningStrategy = null;
                StringBuilder errorSummary = new StringBuilder();

                for (String strat : strategies) {
                    BluetoothSocket candidate = null;
                    try {
                        emitDebug("info", "Versuche RFCOMM-Socket [" + strat + "] zu " + address + "...");
                        candidate = createSocketByStrategy(device, strat);
                        candidate.connect();
                        connectedSock = candidate;
                        winningStrategy = strat;
                        emitDebug("success", "RFCOMM-Socket [" + strat + "] erfolgreich verbunden!");
                        break;
                    } catch (Exception ex) {
                        String errMsg = ex.getClass().getSimpleName() + ": " + ex.getMessage();
                        emitDebug("warn", "Strategie [" + strat + "] fehlgeschlagen -> " + errMsg);
                        if (errorSummary.length() > 0) errorSummary.append(" | ");
                        errorSummary.append(strat).append(": ").append(ex.getMessage());
                        if (candidate != null) {
                            try { candidate.close(); } catch (Exception ignored) {}
                        }
                        try { Thread.sleep(300); } catch (InterruptedException ignored) {}
                    }
                }

                if (connectedSock == null) {
                    call.reject("Alle RFCOMM/SPP Verbindungsstrategien fehlgeschlagen (" + errorSummary + ")");
                    return;
                }

                activeSocket = connectedSock;
                activeInput = connectedSock.getInputStream();
                activeOutput = connectedSock.getOutputStream();
                connectedAddress = address;

                startReaderThread(address, devName);

                JSObject ret = new JSObject();
                ret.put("connected", true);
                ret.put("address", address);
                ret.put("name", devName);
                ret.put("strategy", winningStrategy);
                call.resolve(ret);

            } catch (Exception e) {
                emitDebug("error", "Schwerer Fehler bei connectSpp: " + e.getMessage());
                closeActiveSocketInternal();
                call.reject("connectSpp Fehler: " + e.getMessage());
            }
        });
    }

    @SuppressLint("MissingPermission")
    private BluetoothSocket createSocketByStrategy(BluetoothDevice device, String strategy) throws Exception {
        if ("secure".equals(strategy)) {
            return device.createRfcommSocketToServiceRecord(SPP_UUID);
        } else if ("insecure".equals(strategy)) {
            return device.createInsecureRfcommSocketToServiceRecord(SPP_UUID);
        } else if ("reflection_ch1".equals(strategy)) {
            Method m = device.getClass().getMethod("createRfcommSocket", int.class);
            return (BluetoothSocket) m.invoke(device, 1);
        } else if ("insecure_reflection_ch1".equals(strategy)) {
            Method m = device.getClass().getMethod("createInsecureRfcommSocket", int.class);
            return (BluetoothSocket) m.invoke(device, 1);
        }
        return device.createRfcommSocketToServiceRecord(SPP_UUID);
    }

    private void startReaderThread(final String address, final String devName) {
        readerRunning = true;
        readerThread = new Thread(() -> {
            byte[] buffer = new byte[1024];
            emitDebug("info", "SPP Reader-Thread gestartet für " + devName);
            while (readerRunning && activeInput != null) {
                try {
                    int bytesRead = activeInput.read(buffer);
                    if (bytesRead == -1) {
                        emitDebug("warn", "SPP Stream EOF (Verbindung vom Dongle geschlossen).");
                        break;
                    }
                    if (bytesRead > 0) {
                        byte[] chunk = new byte[bytesRead];
                        System.arraycopy(buffer, 0, chunk, 0, bytesRead);
                        String ascii = new String(chunk, StandardCharsets.UTF_8);
                        StringBuilder hexSb = new StringBuilder(bytesRead * 2);
                        for (byte b : chunk) {
                            hexSb.append(String.format("%02X", b & 0xFF));
                        }
                        JSObject evt = new JSObject();
                        evt.put("data", ascii);
                        evt.put("hex", hexSb.toString());
                        evt.put("bytes", bytesRead);
                        evt.put("address", address);
                        notifyListeners("obdData", evt);
                    }
                } catch (IOException ioEx) {
                    if (readerRunning) {
                        emitDebug("warn", "SPP Lese-Abbruch: " + ioEx.getMessage());
                    }
                    break;
                }
            }

            if (readerRunning) {
                readerRunning = false;
                closeActiveSocketInternal();
                JSObject discEvt = new JSObject();
                discEvt.put("address", address);
                discEvt.put("reason", "stream_closed");
                notifyListeners("obdDisconnected", discEvt);
            }
        }, "obd-spp-reader");
        readerThread.setDaemon(true);
        readerThread.start();
    }

    @PluginMethod
    public void writeSpp(PluginCall call) {
        final String data = call.getString("data", null);
        if (data == null) {
            call.reject("Keine Daten zum Senden angegeben.");
            return;
        }
        ioExecutor.execute(() -> {
            if (activeSocket == null || !activeSocket.isConnected() || activeOutput == null) {
                call.reject("Kein aktiver SPP-Socket verbunden.");
                return;
            }
            try {
                byte[] bytes = data.getBytes(StandardCharsets.UTF_8);
                activeOutput.write(bytes);
                activeOutput.flush();
                JSObject ret = new JSObject();
                ret.put("ok", true);
                ret.put("bytesWritten", bytes.length);
                call.resolve(ret);
            } catch (IOException e) {
                emitDebug("error", "SPP Schreibfehler: " + e.getMessage());
                call.reject("SPP Schreibfehler: " + e.getMessage());
            }
        });
    }

    @PluginMethod
    public void disconnectSpp(PluginCall call) {
        ioExecutor.execute(() -> {
            closeActiveSocketInternal();
            emitDebug("info", "SPP-Verbindung sauber getrennt.");
            JSObject ret = new JSObject();
            ret.put("disconnected", true);
            call.resolve(ret);
        });
    }

    private synchronized void closeActiveSocketInternal() {
        readerRunning = false;
        if (readerThread != null) {
            try { readerThread.interrupt(); } catch (Exception ignored) {}
            readerThread = null;
        }
        if (activeInput != null) {
            try { activeInput.close(); } catch (Exception ignored) {}
            activeInput = null;
        }
        if (activeOutput != null) {
            try { activeOutput.close(); } catch (Exception ignored) {}
            activeOutput = null;
        }
        if (activeSocket != null) {
            try { activeSocket.close(); } catch (Exception ignored) {}
            activeSocket = null;
        }
        connectedAddress = null;
    }

    @Override
    protected void handleOnDestroy() {
        closeActiveSocketInternal();
        super.handleOnDestroy();
    }
}
