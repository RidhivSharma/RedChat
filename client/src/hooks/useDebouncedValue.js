import { useEffect, useState } from 'react';

/**
 * Returns a copy of `value` that only changes after `delay` ms without edits —
 * used to debounce the user-search box (300 ms).
 */
export function useDebouncedValue(value, delay = 300) {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);

  return debounced;
}

export default useDebouncedValue;
