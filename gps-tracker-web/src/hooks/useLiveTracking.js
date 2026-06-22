// useLiveTracking.js — laiv kuzatish holati (userTrackPref / seekerPaused).
// Dashboard'da setView, showSeeker, showMiniSeeker bilan bog'liq mantiqni ajratadi.
import { useState, useEffect, useCallback } from 'react';

/**
 * @param {{ showSeeker: boolean, showMiniSeeker: boolean }} deps
 * @returns {{
 *   userTrackPref: boolean, setUserTrackPref: function,
 *   seekerPaused: boolean,
 *   trackLive: boolean,
 * }}
 */
export function useLiveTracking({ showSeeker, showMiniSeeker }) {
  const [userTrackPref, setUserTrackPref] = useState(false);
  const [seekerPaused,  setSeekerPaused]  = useState(false);

  // Seeker ochiq/yopiq bo'lganda seekerPaused avtomatik toggle
  useEffect(() => {
    setSeekerPaused(!!(showSeeker || showMiniSeeker));
  }, [showSeeker, showMiniSeeker]);

  const trackLive = userTrackPref && !seekerPaused;

  return { userTrackPref, setUserTrackPref, seekerPaused, trackLive };
}
