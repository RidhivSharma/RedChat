import { useEffect } from 'react';
import { setPageTitle } from '../utils/title.js';

/**
 * Declares the current page's title; the unread counter prefix is added on
 * top by the chat layer (utils/title.js).
 */
export function usePageTitle(title) {
  useEffect(() => {
    setPageTitle(title);
  }, [title]);
}

export default usePageTitle;
