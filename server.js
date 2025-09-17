app.post('/crear-preferencia', async (req, res) => {
  try {
    const { title, price, currency, back_urls, metadata } = req.body;

    // Validaciones básicas
    if (!title || typeof title !== 'string') {
      return res.status(400).json({ error: 'title requerido' });
    }
    const amount = Number(price);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: 'price inválido (número > 0)' });
    }
    const curr = (currency || 'ARS').toUpperCase();

    // Construir preferencia (SDK v1.x)
    const pref = {
      items: [
        {
          title,
          unit_price: amount,
          quantity: 1,
          currency_id: curr,
        },
      ],
      back_urls: back_urls || undefined,
      auto_return: 'approved',
      metadata: metadata || undefined,
    };

    const mpResp = await mercadopago.preferences.create(pref);

    // Devolver sólo lo que necesitamos para redirigir
    return res.json({
      init_point: mpResp?.body?.init_point || mpResp?.response?.init_point,
      sandbox_init_point: mpResp?.body?.sandbox_init_point || mpResp?.response?.sandbox_init_point,
      id: mpResp?.body?.id || mpResp?.response?.id,
    });

  } catch (e) {
    // Logs útiles para Render
    console.error('[MP error]', e?.message || e);
    console.error('[MP error data]', e?.response?.data || e?.cause || null);

    // Devolvemos detalle legible para que lo veas con curl
    return res.status(500).json({
      error: 'mp_failed',
      message: e?.message || 'unknown',
      details: e?.response?.data || e?.cause || null,
    });
  }
});


