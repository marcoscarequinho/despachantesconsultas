// Service worker mínimo — existe apenas para satisfazer o critério de
// instalabilidade de PWA (Chrome/Edge exigem um SW registrado com fetch
// handler). Não faz cache: todo request vai direto pra rede, sem interferir
// no site (evita servir dados desatualizados de PIX, saldo, consultas etc.).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request));
});
