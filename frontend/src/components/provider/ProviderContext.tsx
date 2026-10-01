import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { ProviderState } from '../../types/provider';
import { getRequestSummaries } from '../../services/warrantyRequestService';
import { getProviderNotifications, markAllNotificationsAsRead, markNotificationAsRead } from '../../services/providerNotificationService';
import { firestoreError } from '../../utils/providerFirestoreMapping';
interface Value {
  providerId?: string;
  createdRequestId: string | null;
  setCreatedRequestId: (id: string | null) => void;
  state: ProviderState;
  requestsLoading: boolean; requestsError: string; requestsWarning: string;
  notificationsLoading: boolean; notificationsError: string;
  refreshRequests: () => Promise<void>; refreshNotifications: () => Promise<void>;
  markRead: (id?: string) => Promise<void>;
}
const Context = createContext<Value | null>(null);
export function ProviderModuleProvider({ children, providerId, authenticatedProviderId }: { children: ReactNode; providerId?: string; authenticatedProviderId?: string }) {
  const [createdRequestId, setCreatedRequestId] = useState<string | null>(null);
  const [state, setState] = useState<ProviderState>({ requests: [], notifications: [] });
  const [requestsLoading, setRequestsLoading] = useState(true), [requestsError, setRequestsError] = useState(''), [requestsWarning, setRequestsWarning] = useState('');
  const [notificationsLoading, setNotificationsLoading] = useState(true), [notificationsError, setNotificationsError] = useState('');
  const requestsSequence = useRef(0), notificationsSequence = useRef(0);
  const refreshRequests = useCallback(async () => {
    const sequence = ++requestsSequence.current;
    setRequestsLoading(true); setRequestsError(''); setRequestsWarning('');
    try {
      const result = await getRequestSummaries(providerId);
      if (sequence !== requestsSequence.current) return;
      setState(current => ({ ...current, requests: result.items })); setRequestsWarning(result.warnings.join('\n'));
    } catch (error) { if (sequence === requestsSequence.current) setRequestsError(firestoreError(error)); }
    finally { if (sequence === requestsSequence.current) setRequestsLoading(false); }
  }, [providerId]);
  const refreshNotifications = useCallback(async () => {
    const sequence = ++notificationsSequence.current;
    setNotificationsLoading(true); setNotificationsError('');
    try {
      const notifications = await getProviderNotifications(providerId);
      if (sequence === notificationsSequence.current) setState(current => ({ ...current, notifications }));
    } catch (error) { if (sequence === notificationsSequence.current) setNotificationsError(firestoreError(error)); }
    finally { if (sequence === notificationsSequence.current) setNotificationsLoading(false); }
  }, [providerId]);
  useEffect(() => {
    setState({ requests: [], notifications: [] });
    void refreshRequests(); void refreshNotifications();
    return () => { requestsSequence.current++; notificationsSequence.current++; };
  }, [refreshRequests, refreshNotifications]);
  const markRead = async (id?: string) => {
    if (id) await markNotificationAsRead(id); else await markAllNotificationsAsRead(providerId);
    // Refresh errors have their own UI; a completed write is still a successful write.
    await refreshNotifications();
  };
  return <Context.Provider value={{ providerId: authenticatedProviderId ?? providerId, createdRequestId, setCreatedRequestId, state, requestsLoading, requestsError, requestsWarning, notificationsLoading, notificationsError, refreshRequests, refreshNotifications, markRead }}>{children}</Context.Provider>;
}
export function useProviderModule() {
  const value = useContext(Context);
  if (!value) throw new Error('ProviderModuleProvider is required.');
  return value;
}
