import { createContext, useContext } from 'react';
import { useAuth as useAuthState } from '../hooks/useAuth';

const AuthContext = createContext(null);

/**
 * Provides Go-backed auth state and actions to the tree.
 * Mounting this provider runs rehydration from sessionStorage when needed.
 */
export function AuthProvider({ children }) {
  const auth = useAuthState();
  return <AuthContext.Provider value={auth}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return ctx;
}

/**
 * Non-throwing variant for shell components (for example the global
 * bug-report button) that mount inside views both with and without an
 * AuthProvider wrapper. Returns `null` when the provider is absent.
 */
export function useOptionalAuth() {
  return useContext(AuthContext);
}
