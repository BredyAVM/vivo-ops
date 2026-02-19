'use client'
import { useEffect, useState } from "react"
import { supabase } from "@/lib/supabase"

type OrderRow = {
    id: number
    order_number: string
    status: string
    fulfillment: string
    source: string
    total_usd: string | number
    created_at: string
  }  

export default function OrdersPage() {
  const [orders, setOrders] = useState<OrderRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  
  async function load() {
    setLoading(true)
    setError(null)

    const { data, error } = await supabase
      .from('orders')
      .select('id, order_number, status, fulfillment, source, total_usd, created_at')
      .order('created_at', { ascending: false })
      .limit(10)

    if (error) {
      setError(error.message)
      setOrders([])
    } else {
      setOrders((data ?? []) as OrderRow[])
    }

    setLoading(false)
  }


  useEffect(() => {
    load()
  }, [])
  
  
  async function createTestOrder(source: 'master' | 'advisor' | 'walk_in') {
    const { error } = await supabase.from('orders').insert({
      order_number: 'TEST-' + Math.floor(Math.random() * 10000),
      status: 'created',
      fulfillment: 'pickup',
      source,
      total_usd: 10,
    })
  
    if (error) alert(error.message)
    else await load()
  }

  async function createOrderWithOneItem() {
    // 1) Crear la orden
    const order_number = 'TEST-' + Math.floor(Math.random() * 10000)
  
    const { data: order, error: orderError } = await supabase
      .from('orders')
      .insert({
        order_number,
        status: 'created',
        fulfillment: 'pickup',
        source: 'master',
        total_usd: 0, // lo recalculamos luego
      })
      .select('id')
      .single()
  
    if (orderError) {
      alert(orderError.message)
      return
    }
  
        // 2) Buscar 1 producto (el primero)
        const { data: product, error: productError } = await supabase
        .from('products')
        .select('id, sku, name, base_price_usd')
        .eq('is_active', true)
        .order('id', { ascending: true })
        .limit(1)
        .single()

        if (productError) {
        alert(productError.message)
        return
        }


        // 3) Crear 1 item dentro del pedido (precio congelado)
        const qty = 1
            const unit_price_usd_snapshot = product.base_price_usd
            const line_total_usd = Number(unit_price_usd_snapshot) * qty

            const { error: itemError } = await supabase.from('order_items').insert({
            order_id: order.id,
            product_id: product.id,
            qty,
            unit_price_usd_snapshot,
            line_total_usd,
            sku_snapshot: product.sku,
            product_name_snapshot: product.name,
            })

            if (itemError) {
            alert(itemError.message)
            return
            }


  
    // 4) Actualizar total de la orden (por ahora manual)
    const { error: totalError } = await supabase
      .from('orders')
      .update({ total_usd: line_total_usd })
      .eq('id', order.id)
  
    if (totalError) {
      alert(totalError.message)
      return
    }
  
    await load()
  }
  
  
  return (
    <main style={{ padding: 24, fontFamily: 'system-ui' }}>
      <h1 style={{ fontSize: 28, fontWeight: 700 }}>Orders</h1>

      <p style={{ opacity: 0.7 }}>
        Probando conexión con Supabase → tabla <b>orders</b>
      </p>

      {loading && <p>Cargando…</p>}
      {error && (
        <p style={{ color: 'tomato' }}>
          Error: {error}
          <br />
          (Esto suele pasar si RLS está bloqueando o si el env no está bien)
        </p>
      )}

            {!loading && !error && orders.length === 0 && <p>No hay órdenes todavía.</p>}
            <div style={{ display: 'flex', gap: 10, marginBottom: 20, flexWrap: 'wrap' }}>
        <button
            onClick={() => createTestOrder('master')}
            style={{ background: '#22c55e', padding: '10px 14px', borderRadius: 8 }}
        >
            Pickup (Master)
        </button>

        <button
            onClick={() => createTestOrder('advisor')}
            style={{ background: '#3b82f6', padding: '10px 14px', borderRadius: 8 }}
        >
            Pickup (Advisor)
        </button>

        <button
            onClick={() => createTestOrder('walk_in')}
            style={{ background: '#f59e0b', padding: '10px 14px', borderRadius: 8 }}
        >
            Pickup (Walk-in)
        </button>

        <button
            onClick={createOrderWithOneItem}
            style={{ background: '#a855f7', padding: '10px 14px', borderRadius: 8 }}
            >
            Crear pedido + 1 item
        </button>

        </div>

      {!loading && !error && orders.length > 0 && (
        <div style={{ marginTop: 16, overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', width: '100%' }}>
            <thead>
              <tr>
                {['#', 'order_number', 'status', 'fulfillment', 'source', 'total_usd', 'created_at', 'items']

.map((h) => (
                  <th
                    key={h}
                    style={{
                      textAlign: 'left',
                      borderBottom: '1px solid #333',
                      padding: '10px 8px',
                    }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {orders.map((o, idx) => (
                <tr key={o.id}>
                  <td style={{ padding: '10px 8px', borderBottom: '1px solid #222' }}>{idx + 1}</td>
                  <td style={{ padding: '10px 8px', borderBottom: '1px solid #222' }}>{o.order_number}</td>
                  <td style={{ padding: '10px 8px', borderBottom: '1px solid #222' }}>{o.status}</td>
                  <td style={{ padding: '10px 8px', borderBottom: '1px solid #222' }}>{o.fulfillment}</td>
                  <td style={{ padding: '10px 8px', borderBottom: '1px solid #222' }}>{o.source}</td>
                  <td style={{ padding: '10px 8px', borderBottom: '1px solid #222' }}>{String(o.total_usd)}</td>
                  <td style={{ padding: '10px 8px', borderBottom: '1px solid #222' }}>{new Date(o.created_at).toLocaleString()}</td>
                  <td style={{ padding: '10px 8px', borderBottom: '1px solid #222' }}>
                            <a href={`/orders/${o.id}`} style={{ color: '#60a5fa' }}> Ver</a></td>

                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  )
}
