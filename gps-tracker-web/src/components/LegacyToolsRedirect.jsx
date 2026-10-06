import { Navigate, useLocation } from 'react-router-dom';

// Old app shortcuts/bookmarks keep their device/date parameters and replace the
// history entry, so Back cannot bounce between the retired tab and Home.
export default function LegacyToolsRedirect() {
  const { search, hash } = useLocation();
  return <Navigate to={{ pathname: '/', search, hash }} replace />;
}
