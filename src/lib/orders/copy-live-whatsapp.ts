import { loadLiveOrderWhatsAppAction } from './live-whatsapp-action';

export async function copyLiveOrderWhatsApp(orderId: number) {
  const freshText = loadLiveOrderWhatsAppAction(orderId).then(result => {
    if (!result.ok) throw new Error(result.message);
    return result.text;
  });
  // Reserve clipboard access inside the tap, before the network wait (iPhone/Safari).
  try {
    if (typeof ClipboardItem !== 'undefined' && navigator.clipboard.write) {
      await navigator.clipboard.write([new ClipboardItem({
        'text/plain': freshText.then(text => new Blob([text], {type: 'text/plain'})),
      })]);
    } else {
      await navigator.clipboard.writeText(await freshText);
    }
  } catch {
    // Consume a failed read even when the clipboard permission failed first.
    await freshText;
    throw new Error('No se pudo copiar. Permite el acceso al portapapeles y vuelve a intentar.');
  }
}
