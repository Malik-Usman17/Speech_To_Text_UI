import { defineConfig } from 'vite'


export default defineConfig({
    server: {
        port: 5173,
        strictPort: true,
        https: false, // set true if you have local certs; mic works on localhost even without HTTPS
        proxy: {
            // Proxy API calls during dev to your backend
            '/api': {
                target: 'http://localhost:3000', // change to your backend
                changeOrigin: true,
            }
        }
    }
})