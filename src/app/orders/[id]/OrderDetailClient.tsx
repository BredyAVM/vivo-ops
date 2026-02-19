'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { supabase } from '@/lib/supabase'

type OrderItemRow = {
  id: number
  order_id: number
  sku_snapshot: string | null
  product_name_snapshot: string
  qty: number
  unit_price_usd_snapshot: number
  line_total_usd: number
  notes: string | null
}

export default function OrderDetailClient() {
  const params = useParams()
  const rawId = params?.id
  const orderId = Number(Array.isArray(rawId) ? rawId[0] : rawId)

  const [items, setItems] = useState<OrderItemRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    async function loadItems() {
      setLoading(true)
      setError(null)

      if (!Number.isFinite(orderId)) {
        setError('Invalid order id.')
        setLoading(false)
        return
      }

      const { data, error } = await supabase
        .from('order_items')
        .select('id, order_id, sku_snapshot, product_name_snapshot, qty, unit_price_usd_snapshot, line_total_usd, notes')
        .eq('order_id', orderId)
        .order('id', { ascending: true })

      if (error) {
        setError(error.message)
        setItems([])
      } else {
        setItems((data ?? []) as OrderItemRow[])
      }

      setLoading(false)
    }

    loadItems()
  }, [orderId])

  return (
    <main style={{ padding: 24, fontFamily: 'system-ui' }}>
      <h1 style={{ fontSize: 24, fontWeight: 700 }}>Order Items</h1>
      <p style={{ opacity: 0.7 }}>Order ID: <b>{Number.isFinite(orderId) ? orderId : '—'}</b></p>

      {loading && <p>Cargando…</p>}
      {error && <p style={{ color: 'tomato' }}>Error: {error}</p>}

      {!loading && !error && items.length === 0 && <p>Este pedido no tiene items.</p>}

      {!loading && !error && items.length > 0 && (
        <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 16 }}>
          <thead>
            <tr>
              {['#', 'sku', 'name', 'qty', 'unit', 'line_total', 'notes'].map((h) => (
                <th key={h} style={{ textAlign: 'left', borderBottom: '1px solid #333', padding: '10px 8px' }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {items.map((it, idx) => (
              <tr key={it.id}>
                <td style={{ padding: '10px 8px', borderBottom: '1px solid #222' }}>{idx + 1}</td>
                <td style={{ padding: '10px 8px', borderBottom: '1px solid #222' }}>{it.sku_snapshot ?? ''}</td>
                <td style={{ padding: '10px 8px', borderBottom: '1px solid #222' }}>{it.product_name_snapshot}</td>
                <td style={{ padding: '10px 8px', borderBottom: '1px solid #222' }}>{it.qty}</td>
                <td style={{ padding: '10px 8px', borderBottom: '1px solid #222' }}>{it.unit_price_usd_snapshot}</td>
                <td style={{ padding: '10px 8px', borderBottom: '1px solid #222' }}>{it.line_total_usd}</td>
                <td style={{ padding: '10px 8px', borderBottom: '1px solid #222' }}>{it.notes ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  )
}
