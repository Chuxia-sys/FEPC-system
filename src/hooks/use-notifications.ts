'use client';

import { useEffect, useRef, useCallback } from 'react';
import { useSession } from 'next-auth/react';
import { toast } from 'sonner';
import type { Socket } from 'socket.io-client';

export interface NotificationData {
  id: string;
  title: string;
  message: string;
  type: 'info' | 'success' | 'warning' | 'error';
  timestamp: string;
}

export function useNotifications() {
  const { data: session } = useSession();
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    // Only connect if user is logged in
    if (!session?.user?.id) return;

    let isMounted = true;

    const initSocket = async () => {
      try {
        // Dynamically import socket.io-client to avoid initial load errors
        const { io } = await import('socket.io-client');
        
        if (!isMounted) return;

        // Connect to notification WebSocket server
        // Use XTransformPort for the gateway
        const socket = io('/?XTransformPort=3003', {
          transports: ['websocket', 'polling'],
          forceNew: true,
          reconnection: true,
          reconnectionAttempts: 5,
          reconnectionDelay: 1000,
          timeout: 10000,
        });

        if (!isMounted) {
          socket.disconnect();
          return;
        }

        socketRef.current = socket;

        socket.on('connect', () => {
          console.log('[Notifications] Connected to notification service');
          // Join with user ID to receive targeted notifications
          socket.emit('join', { userId: session.user.id });
        });

        socket.on('disconnect', () => {
          console.log('[Notifications] Disconnected from notification service');
        });

        // Handle incoming notifications
        socket.on('notification', (data: NotificationData) => {
          console.log('[Notifications] Received:', data);
          
          // Show toast notification based on type
          switch (data.type) {
            case 'success':
              toast.success(data.title, {
                description: data.message,
              });
              break;
            case 'warning':
              toast.warning(data.title, {
                description: data.message,
              });
              break;
            case 'error':
              toast.error(data.title, {
                description: data.message,
              });
              break;
            case 'info':
            default:
              toast.info(data.title, {
                description: data.message,
              });
              break;
          }
        });

        socket.on('connect_error', (error) => {
          console.error('[Notifications] Connection error:', error);
        });
      } catch (error) {
        console.error('[Notifications] Failed to initialize socket:', error);
        // Silently fail - don't crash the app
      }
    };

    initSocket();

    return () => {
      isMounted = false;
      if (socketRef.current) {
        socketRef.current.disconnect();
        socketRef.current = null;
      }
    };
  }, [session?.user?.id]);

  const sendNotification = useCallback((userId: string, title: string, message: string, type: NotificationData['type'] = 'info') => {
    if (socketRef.current?.connected) {
      socketRef.current.emit('send-notification', { userId, title, message, type });
    }
  }, []);

  return { sendNotification };
}
