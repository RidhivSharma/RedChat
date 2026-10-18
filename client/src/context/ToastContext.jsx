import { createContext, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Toast from '../components/Toast.jsx';

export const ToastContext = createContext(null);

const DEFAULT_DURATION = 4500;
const MAX_VISIBLE = 4;

let nextToastId = 0;

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const timersRef = useRef(new Map());

  const dismissToast = useCallback((id) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
    const timer = timersRef.current.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
  }, []);

  /**
   * showToast('Saved!', 'success') — type is one of info | success | error.
   * Pass { duration: 0 } to keep the toast until it is dismissed manually.
   */
  const showToast = useCallback(
    (message, type = 'info', options = {}) => {
      const text = String(message ?? '').trim();
      if (!text) return null;

      const id = (nextToastId += 1);
      const duration = Number.isFinite(options.duration) ? options.duration : DEFAULT_DURATION;

      setToasts((current) => [...current.slice(-(MAX_VISIBLE - 1)), { id, message: text, type }]);

      if (duration > 0) {
        timersRef.current.set(
          id,
          setTimeout(() => dismissToast(id), duration)
        );
      }
      return id;
    },
    [dismissToast]
  );

  // Clear pending timers when the provider unmounts.
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      timers.forEach((timer) => clearTimeout(timer));
      timers.clear();
    };
  }, []);

  const value = useMemo(
    () => ({ toasts, showToast, dismissToast }),
    [toasts, showToast, dismissToast]
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-viewport" aria-label="Notifications">
        {toasts.map((toast) => (
          <Toast key={toast.id} toast={toast} onDismiss={dismissToast} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}
