import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { onAuthStateChanged } from 'firebase/auth';
import { auth } from '../../config/firebase';
import { getUserProfile, loginUser, logoutUser, type LoggedInUser, type UserRole } from '../../services/authService';
type Session = { user: LoggedInUser | null; loading: boolean; error: string; login: (email: string, password: string, role: UserRole) => Promise<void>; logout: () => Promise<void> };
const Context = createContext<Session | null>(null);
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<LoggedInUser | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState('');
  const signingIn = useRef(false), generation = useRef(0);
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, firebaseUser => {
      const version = ++generation.current;
      // loginUser must finish checking the selected role before protected routes mount.
      if (signingIn.current) return;
      setUser(null); setError(''); setLoading(true);
      if (!firebaseUser) { setLoading(false); return; }
      void getUserProfile(firebaseUser).then(profile => {
        if (generation.current === version) setUser(profile);
      }).catch(cause => {
        if (generation.current === version) setError(cause instanceof Error ? cause.message : 'Could not load your account.');
      }).finally(() => { if (generation.current === version) setLoading(false); });
    });
    return () => { generation.current++; unsubscribe(); };
  }, []);
  async function login(email: string, password: string, role: UserRole) {
    if (signingIn.current) return;
    signingIn.current = true; generation.current++; setError('');
    try {
      const profile = await loginUser(email, password, role);
      if (auth.currentUser?.uid === profile.uid) setUser(profile);
    } catch (cause) {
      setUser(null);
      await logoutUser();
      throw cause;
    } finally { signingIn.current = false; setLoading(false); }
  }
  async function logout() { await logoutUser(); generation.current++; setUser(null); setError(''); }
  return <Context.Provider value={{ user, loading, error, login, logout }}>{children}</Context.Provider>;
}
export function useAuth() { const value = useContext(Context); if (!value) throw new Error('AuthProvider is required.'); return value; }
