// Pulso do gerador fora da thread principal: timers de página oculta são estrangulados, os de worker não.
setInterval(() => postMessage(0), 40);
