// Isolated preview only. Production uses the ordinary vite.config.js.
import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import {fileURLToPath} from 'node:url';
export default defineConfig({base:'/',plugins:[{name:'fixture-map',enforce:'pre',resolveId(id,importer){if(id==='../components/KakaoMap' && importer?.endsWith('/pages/FleetDashboard.jsx'))return fileURLToPath(new URL('./fleet-preview-map.jsx',import.meta.url));}},react()]});
