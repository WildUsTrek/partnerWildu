self.addEventListener('install', (event) => {
  console.log('✅ SW installato');
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  console.log('✅ SW attivo');
});

