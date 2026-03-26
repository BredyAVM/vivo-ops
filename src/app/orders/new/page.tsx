'use client'

import { FormEvent, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createSupabaseBrowser } from '@/lib/supabase'

type ClientChannelType = 'assigned' | 'own' | 'legacy'
type FulfillmentType = 'pickup' | 'delivery'
type OrderSource = 'advisor' | 'master' | 'walk_in'
type OrderStatus = 'created' | 'queued'

type ClientRow = {
  id: number
  full_name: string
  phone: string | null
  client_type: string | null
}

type ProductRow = {
  id: number
  sku: string | null
  name: string
  base_price_usd: number | string | null
  is_active?: boolean
}

type DraftItem = {
  localId: string
  product_id: number
  sku_snapshot: string | null
  product_name_snapshot: string
  qty: number
  unit_price_usd_snapshot: number
  line_total_usd: number
}

type AdvisorOption = {
  user_id: string
  full_name: string
  is_active: boolean
}

function pad2(n: number) {
  return String(n).padStart(2, '0')
}

function pad4(n: number) {
  return String(n).padStart(4, '0')
}

function getTodayLocalDateInputValue() {
  const now = new Date()
  const y = now.getFullYear()
  const m = pad2(now.getMonth() + 1)
  const d = pad2(now.getDate())
  return `${y}-${m}-${d}`
}

function todayKey() {
  const now = new Date()
  const y = now.getFullYear()
  const m = pad2(now.getMonth() + 1)
  const d = pad2(now.getDate())
  return `${y}${m}${d}`
}

function getRoundedNextHalfHour(now = new Date()) {
  const d = new Date(now)
  d.setSeconds(0, 0)
  const mins = d.getMinutes()

  if (mins === 0 || mins === 30) return d
  if (mins < 30) {
    d.setMinutes(30)
    return d
  }

  d.setHours(d.getHours() + 1)
  d.setMinutes(0)
  return d
}

function to12hParts(date: Date) {
  let hours24 = date.getHours()
  const minutes = date.getMinutes()
  const ampm: 'AM' | 'PM' = hours24 >= 12 ? 'PM' : 'AM'
  let hours12 = hours24 % 12
  if (hours12 === 0) hours12 = 12

  return {
    hour12: String(hours12),
    minute: String(minutes),
    ampm,
  }
}

function from12hTo24h(hour12: string, minute: string, ampm: 'AM' | 'PM') {
  let h = Number(hour12)
  let m = Number(minute)

  if (!Number.isFinite(h) || h < 1 || h > 12) {
    throw new Error('Hora inválida (1–12).')
  }

  if (!Number.isFinite(m) || m < 0 || m > 59) {
    throw new Error('Minutos inválidos (0–59).')
  }

  if (ampm === 'AM') {
    if (h === 12) h = 0
  } else {
    if (h !== 12) h = h + 12
  }

  return `${pad2(h)}:${pad2(m)}`
}

function normalizePhone(raw: string) {
  return raw.replace(/[^\d+]/g, '')
}

export default function NewOrderPage() {
  const router = useRouter()
  const supabase = useMemo(() => createSupabaseBrowser(), [])

  // Auth / persona / roles
  const [authUserId, setAuthUserId] = useState<string | null>(null)
  const [authEmail, setAuthEmail] = useState<string | null>(null)
  const [roleList, setRoleList] = useState<string[]>([])
  const [isAdmin, setIsAdmin] = useState(false)
  const [isMaster, setIsMaster] = useState(false)
  const [isAdvisor, setIsAdvisor] = useState(false)

  // Advisors (for master/admin assignment)
  const [advisors, setAdvisors] = useState<AdvisorOption[]>([])
  const [selectedAdvisorUserId, setSelectedAdvisorUserId] = useState<string>('')

  // UI
  const [loadingInit, setLoadingInit] = useState(true)
  const [saving, setSaving] = useState(false)
  const [creatingClientNow, setCreatingClientNow] = useState(false)
  const [searchingClient, setSearchingClient] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)

  // Quote mode
  const [quoteOnly, setQuoteOnly] = useState(true)

  // Products & draft items
  const [products, setProducts] = useState<ProductRow[]>([])
  const [selectedProductId, setSelectedProductId] = useState<number | ''>('')
  const [qty, setQty] = useState<number>(1)
  const [draftItems, setDraftItems] = useState<DraftItem[]>([])

  // Client search/select/create
  const [searchTerm, setSearchTerm] = useState('')
  const [clientResults, setClientResults] = useState<ClientRow[]>([])
  const [selectedClient, setSelectedClient] = useState<ClientRow | null>(null)

  const [isNewClientMode, setIsNewClientMode] = useState(false)
  const [newClientName, setNewClientName] = useState('')
  const [newClientPhone, setNewClientPhone] = useState('')
  const [newClientType, setNewClientType] = useState<ClientChannelType>('assigned')

  // Order core data
  const [source, setSource] = useState<OrderSource>('advisor')
  const [status, setStatus] = useState<OrderStatus>('created')
  const [fulfillment, setFulfillment] = useState<FulfillmentType>('pickup')

  // Delivery scheduling
  const [deliveryDate, setDeliveryDate] = useState<string>(getTodayLocalDateInputValue())
  const rounded = getRoundedNextHalfHour()
  const roundedParts = to12hParts(rounded)
  const [deliveryHour12, setDeliveryHour12] = useState<string>(roundedParts.hour12)
  const [deliveryMinute, setDeliveryMinute] = useState<string>(roundedParts.minute)
  const [deliveryAmPm, setDeliveryAmPm] = useState<'AM' | 'PM'>(roundedParts.ampm)

  // Receiver / address (se guardan en extra_fields)
  const [receiverName, setReceiverName] = useState('')
  const [receiverPhone, setReceiverPhone] = useState('')
  const [deliveryAddress, setDeliveryAddress] = useState('')

  // General order note (se guarda en notes o extra_fields)
  const [orderNote, setOrderNote] = useState('')

  const selectedProduct = useMemo(() => {
    if (selectedProductId === '') return null
    return products.find((p) => p.id === selectedProductId) ?? null
  }, [selectedProductId, products])

  const draftTotalUsd = useMemo(() => {
    return draftItems.reduce((sum, it) => sum + Number(it.line_total_usd || 0), 0)
  }, [draftItems])

  const canShowBudget = draftItems.length > 0

  const hasClientSelectedOrToCreate =
    !!selectedClient || (isNewClientMode && newClientName.trim().length > 0)

  const canChooseSource = isAdmin || isMaster
  const canChooseAdvisor = isAdmin || isMaster

  const canCreateOrder = useMemo(() => {
    if (draftItems.length === 0) return false
    if (!hasClientSelectedOrToCreate) return false
    if (fulfillment === 'delivery' && !deliveryAddress.trim()) return false

    // si master/admin está creando como advisor, debe elegir asesor
    if ((isAdmin || isMaster) && source === 'advisor' && !selectedAdvisorUserId) return false

    // si asesor logueado, debe quedar autoasignado
    if (isAdvisor && !selectedAdvisorUserId) return false

    return true
  }, [
    draftItems.length,
    hasClientSelectedOrToCreate,
    fulfillment,
    deliveryAddress,
    isAdmin,
    isMaster,
    isAdvisor,
    source,
    selectedAdvisorUserId,
  ])

  function clearMessages() {
    setError(null)
    setInfo(null)
  }

  // ---------- boot ----------
  useEffect(() => {
    async function boot() {
      setLoadingInit(true)
      setError(null)

      const { data: authData, error: authError } = await supabase.auth.getUser()
      if (authError) {
        setError(authError.message)
        setLoadingInit(false)
        return
      }

      const user = authData.user
      if (!user) {
        router.push('/login')
        return
      }

      setAuthUserId(user.id)
      setAuthEmail(user.email ?? null)

      // Roles
      const { data: rolesData, error: rolesError } = await supabase
        .from('user_roles')
        .select('role')
        .eq('user_id', user.id)

      if (rolesError) {
        setError(rolesError.message)
        setLoadingInit(false)
        return
      }

      const roles = (rolesData ?? []).map((r: any) => String(r.role))
      setRoleList(roles)

      const _isAdmin = roles.includes('admin')
      const _isMaster = roles.includes('master')
      const _isAdvisor = roles.includes('advisor')

      setIsAdmin(_isAdmin)
      setIsMaster(_isMaster)
      setIsAdvisor(_isAdvisor)

      // Source default according to role
      if (_isMaster || _isAdmin) {
        setSource('master')
      } else {
        setSource('advisor')
      }

      // ✅ Si es asesor, autoasignarse como attributed_advisor_id
      if (_isAdvisor) {
        setSelectedAdvisorUserId(user.id)
      }

      // Products
      const { data: productsData, error: productsError } = await supabase
        .from('products')
        .select('id, sku, name, base_price_usd, is_active')
        .eq('is_active', true)
        .order('name', { ascending: true })

      if (productsError) {
        setError(productsError.message)
        setLoadingInit(false)
        return
      }

      setProducts((productsData ?? []) as ProductRow[])

      // Advisors list (solo si master/admin)
      if (_isAdmin || _isMaster) {
        const { data: advisorRoleRows, error: advisorRoleErr } = await supabase
          .from('user_roles')
          .select('user_id')
          .eq('role', 'advisor')

        if (advisorRoleErr) {
          setError(advisorRoleErr.message)
          setLoadingInit(false)
          return
        }

        const advisorIds = Array.from(new Set((advisorRoleRows ?? []).map((r: any) => String(r.user_id))))

        if (advisorIds.length > 0) {
          const { data: profileRows, error: profilesErr } = await supabase
            .from('profiles')
            .select('id, full_name, is_active')
            .in('id', advisorIds)

          if (profilesErr) {
            setError(profilesErr.message)
            setLoadingInit(false)
            return
          }

          const advisorOptions: AdvisorOption[] = (profileRows ?? [])
            .map((p: any) => ({
              user_id: String(p.id),
              full_name: String(p.full_name ?? 'Sin nombre'),
              is_active: Boolean(p.is_active ?? true),
            }))
            .sort((a, b) => a.full_name.localeCompare(b.full_name))

          setAdvisors(advisorOptions)
        }
      }

      setLoadingInit(false)
    }

    boot()
  }, [router, supabase])

  // =========================
  // CLIENTS
  // =========================
  async function handleSearchClients(e?: FormEvent) {
    e?.preventDefault()
    clearMessages()

    const raw = searchTerm.trim()
    if (!raw) {
      setClientResults([])
      return
    }

    setSearchingClient(true)

    const q = raw.replace(/,/g, ' ').replace(/\s+/g, ' ').trim()

    const { data, error } = await supabase
      .from('clients')
      .select('id, full_name, phone, client_type')
      .or(`phone.ilike.%${q}%,full_name.ilike.%${q}%`)
      .order('id', { ascending: false })
      .limit(15)

    setSearchingClient(false)

    if (error) {
      setError(error.message)
      setClientResults([])
      return
    }

    setClientResults((data ?? []) as ClientRow[])
    setInfo((data ?? []).length > 0 ? `${(data ?? []).length} cliente(s) encontrado(s)` : 'No se encontraron clientes')
  }

  function selectClient(client: ClientRow) {
    clearMessages()
    setSelectedClient(client)
    setIsNewClientMode(false)

    if (!receiverName && client.full_name) setReceiverName(client.full_name)
    if (!receiverPhone && client.phone) setReceiverPhone(client.phone)
  }

  function activateNewClientMode() {
    clearMessages()
    setSelectedClient(null)
    setIsNewClientMode(true)

    if (!newClientPhone && searchTerm.trim()) {
      setNewClientPhone(searchTerm.trim())
    }
  }

  async function createClientNow() {
    clearMessages()

    if (!isNewClientMode) {
      setError('Primero activa "Cliente nuevo".')
      return
    }

    const full_name = newClientName.trim()
    const phone = normalizePhone(newClientPhone.trim())

    if (!full_name) {
      setError('Nombre del cliente es obligatorio.')
      return
    }

    if (!phone) {
      setError('Teléfono del cliente es obligatorio.')
      return
    }

    setCreatingClientNow(true)

    try {
      const { data: existing, error: existingError } = await supabase
        .from('clients')
        .select('id, full_name, phone, client_type')
        .eq('phone', phone)
        .limit(1)

      if (existingError) throw new Error(existingError.message)

      if ((existing ?? []).length > 0) {
        const c = existing![0] as ClientRow
        setSelectedClient(c)
        setIsNewClientMode(false)
        setInfo(`Ese teléfono ya existe. Se seleccionó: ${c.full_name}`)

        if (!receiverName && c.full_name) setReceiverName(c.full_name)
        if (!receiverPhone && c.phone) setReceiverPhone(c.phone)
        return
      }

      const { data: created, error: createError } = await supabase
        .from('clients')
        .insert({
          full_name,
          phone,
          client_type: newClientType,
        })
        .select('id, full_name, phone, client_type')
        .single()

      if (createError) throw new Error(createError.message)

      const c = created as ClientRow

      setSelectedClient(c)
      setIsNewClientMode(false)
      setClientResults([])
      setSearchTerm(c.phone ?? '')
      setInfo(`Cliente creado: ${c.full_name}`)

      if (!receiverName) setReceiverName(c.full_name)
      if (!receiverPhone && c.phone) setReceiverPhone(c.phone)
    } catch (e: any) {
      setError(e?.message ?? 'Error creando cliente')
    } finally {
      setCreatingClientNow(false)
    }
  }

  async function ensureClientId(): Promise<number> {
    if (selectedClient) return selectedClient.id

    if (!isNewClientMode) {
      throw new Error('Debes seleccionar o crear un cliente.')
    }

    await createClientNow()

    const phone = normalizePhone(newClientPhone.trim())
    const { data, error } = await supabase
      .from('clients')
      .select('id')
      .eq('phone', phone)
      .limit(1)

    if (error) throw new Error(error.message)
    if (!data || data.length === 0) throw new Error('No se pudo confirmar el cliente creado.')

    return Number(data[0].id)
  }

  // =========================
  // DRAFT ITEMS
  // =========================
  function addDraftItem() {
    clearMessages()

    if (selectedProductId === '') {
      setError('Selecciona un producto.')
      return
    }

    if (!Number.isFinite(qty) || qty <= 0) {
      setError('Qty debe ser > 0.')
      return
    }

    const p = products.find((x) => x.id === selectedProductId)
    if (!p) {
      setError('Producto no encontrado.')
      return
    }

    const unit = Number(p.base_price_usd ?? 0)
    const line = unit * qty

    setDraftItems((prev) => [
      ...prev,
      {
        localId: `${Date.now()}-${Math.random()}`,
        product_id: p.id,
        sku_snapshot: p.sku ?? null,
        product_name_snapshot: p.name,
        qty,
        unit_price_usd_snapshot: unit,
        line_total_usd: line,
      },
    ])

    setSelectedProductId('')
    setQty(1)
  }

  function removeDraftItem(localId: string) {
    setDraftItems((prev) => prev.filter((it) => it.localId !== localId))
  }

  function updateDraftQty(localId: string, nextQty: number) {
    if (!Number.isFinite(nextQty) || nextQty <= 0) return

    setDraftItems((prev) =>
      prev.map((it) =>
        it.localId === localId
          ? {
              ...it,
              qty: nextQty,
              line_total_usd: Number(it.unit_price_usd_snapshot) * nextQty,
            }
          : it
      )
    )
  }

  async function showBudget() {
    clearMessages()

    if (!canShowBudget) {
      setError('Agrega al menos 1 item.')
      return
    }

    setInfo(`Presupuesto: $${draftTotalUsd.toFixed(2)} USD`)
  }

  function resolveAttributedAdvisorId(): string {
    // ✅ Siempre devolvemos un attributed_advisor_id válido
    // - Advisor logueado: él mismo
    // - Master/Admin:
    //   - si source=advisor: el seleccionado
    //   - si source=master/walk_in: el mismo master/admin (para cumplir NOT NULL)
    if (isAdvisor && authUserId) return authUserId

    if ((isAdmin || isMaster) && source === 'advisor') {
      return selectedAdvisorUserId // ya validamos que no sea vacío
    }

    // fallback: el usuario creador (master/admin)
    return authUserId ?? ''
  }

  async function generateOrderNumber(): Promise<string> {
    const base = `VO-${todayKey()}-`
    const rand = Math.floor(Math.random() * 10000)
    return base + pad4(rand)
  }

  function buildExtraFields() {
    // Guardamos semántica operativa aquí (no dependemos de columnas que no existen)
    let delivery_time_24: string | null = null
    try {
      delivery_time_24 = from12hTo24h(deliveryHour12, deliveryMinute, deliveryAmPm)
    } catch {
      delivery_time_24 = null
    }

    return {
      schedule: {
        date: deliveryDate,
        time_12: `${deliveryHour12}:${pad2(Number(deliveryMinute || 0))} ${deliveryAmPm}`,
        time_24: delivery_time_24,
      },
      receiver: {
        name: receiverName.trim() || null,
        phone: receiverPhone.trim() ? normalizePhone(receiverPhone.trim()) : null,
      },
      delivery: {
        address: fulfillment === 'delivery' ? (deliveryAddress.trim() || null) : null,
      },
      note: orderNote.trim() || null,
      ui: {
        quote_only: quoteOnly,
      },
    }
  }

  async function handleCreateOrder(e: FormEvent) {
    e.preventDefault()
    clearMessages()

    if (draftItems.length === 0) {
      setError('Agrega al menos 1 producto.')
      return
    }

    if (!hasClientSelectedOrToCreate) {
      setError('Debes seleccionar o crear un cliente para crear la orden.')
      return
    }

    if (fulfillment === 'delivery' && !deliveryAddress.trim()) {
      setError('Para delivery, la dirección es obligatoria.')
      return
    }

    // Validación hora (solo para guardar coherente)
    try {
      from12hTo24h(deliveryHour12, deliveryMinute, deliveryAmPm)
    } catch (e: any) {
      setError(e?.message ?? 'Hora inválida.')
      return
    }

    // ✅ Si está en modo presupuesto, NO creamos orden
    if (quoteOnly) {
      setInfo(`Presupuesto listo: $${draftTotalUsd.toFixed(2)} USD (no se creó la orden porque estás en modo presupuesto).`)
      return
    }

    // Validaciones por rol/source
    if ((isAdmin || isMaster) && source === 'advisor' && !selectedAdvisorUserId) {
      setError('Debes seleccionar un asesor para esta orden (source=advisor).')
      return
    }

    if (isAdvisor && !authUserId) {
      setError('No se detectó usuario logueado.')
      return
    }

    setSaving(true)

    try {
      const clientId = await ensureClientId()

      const order_number = await generateOrderNumber()
      const attributed_advisor_id = resolveAttributedAdvisorId()

      if (!attributed_advisor_id) {
        throw new Error('No se pudo resolver attributed_advisor_id (es obligatorio).')
      }

      const total = draftItems.reduce((acc, it) => acc + Number(it.line_total_usd), 0)

      // ✅ Insert order alineado a tu schema + RLS
      const { data: order, error: orderError } = await supabase
        .from('orders')
        .insert({
          order_number,
          client_id: clientId,
          created_by_user_id: authUserId, // ✅
          attributed_advisor_id, // ✅ (antes advisor_user_id)
          source,
          status, // created/queued
          fulfillment,
          total_usd: total, // podemos setear de una
          is_price_locked: false,
          notes: orderNote.trim() === '' ? null : orderNote.trim(),
          extra_fields: buildExtraFields(), // ✅ donde guardamos delivery/address/receiver/schedule
        })
        .select('id')
        .single()

      if (orderError) throw new Error(orderError.message)

      const itemsPayload = draftItems.map((it) => ({
        order_id: order.id,
        product_id: it.product_id,
        qty: it.qty,
        unit_price_usd_snapshot: it.unit_price_usd_snapshot,
        line_total_usd: it.line_total_usd,
        sku_snapshot: it.sku_snapshot,
        product_name_snapshot: it.product_name_snapshot,
        notes: null,
      }))

      const { error: itemsError } = await supabase.from('order_items').insert(itemsPayload)
      if (itemsError) throw new Error(itemsError.message)

      // (Opcional) Si tienes trigger que recalcula total_usd, esto no hace daño.
      const { error: totalError } = await supabase
        .from('orders')
        .update({ total_usd: total })
        .eq('id', order.id)

      if (totalError) throw new Error(totalError.message)

      router.push(`/orders/${order.id}`)
    } catch (e: any) {
      setError(e?.message ?? 'Error creando orden')
    } finally {
      setSaving(false)
    }
  }

  if (loadingInit) {
    return (
      <main style={{ padding: 24, fontFamily: 'system-ui' }}>
        <h1 style={{ fontSize: 28, fontWeight: 700 }}>Nueva Orden</h1>
        <p>Cargando…</p>
      </main>
    )
  }

  const advisorSelectedLabel =
    advisors.find((a) => a.user_id === selectedAdvisorUserId)?.full_name ?? '—'

  return (
    <main style={{ padding: 16, fontFamily: 'system-ui', maxWidth: 980, margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <h1 style={{ margin: 0, fontSize: 26, fontWeight: 700 }}>Nueva Orden</h1>

        <button
          type="button"
          onClick={() => router.push('/orders')}
          style={{
            padding: '10px 14px',
            borderRadius: 8,
            border: '1px solid #444',
            background: 'transparent',
            color: 'white',
            cursor: 'pointer',
          }}
        >
          ← Volver
        </button>
      </div>

      {/* Usuario / roles */}
      <section
        style={{
          marginTop: 12,
          padding: 12,
          border: '1px solid #222',
          borderRadius: 10,
          background: '#111',
        }}
      >
        <div style={{ fontWeight: 700, marginBottom: 6 }}>Usuario logueado</div>
        <div style={{ opacity: 0.85 }}>ID: <b>{authUserId ?? '—'}</b></div>
        <div style={{ opacity: 0.85 }}>Email: <b>{authEmail ?? '—'}</b></div>
        <div style={{ opacity: 0.85 }}>
          Roles: <b>{roleList.length ? roleList.join(', ') : 'sin roles'}</b>
        </div>
      </section>

      {error && (
        <div style={{ marginTop: 12, padding: 12, borderRadius: 10, background: '#3a1515', border: '1px solid #7f1d1d', color: '#fecaca' }}>
          {error}
        </div>
      )}

      {info && (
        <div style={{ marginTop: 12, padding: 12, borderRadius: 10, background: '#0f172a', border: '1px solid #1e293b', color: '#cbd5e1' }}>
          {info}
        </div>
      )}

      <form onSubmit={handleCreateOrder}>
        {/* Modo presupuesto */}
        <section style={{ marginTop: 14, padding: 14, border: '1px solid #222', borderRadius: 10 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <input type="checkbox" checked={quoteOnly} onChange={(e) => setQuoteOnly(e.target.checked)} />
            <span><b>Modo presupuesto</b> (si está ON, NO se crea la orden)</span>
          </label>
          {quoteOnly && (
            <div style={{ marginTop: 8, fontSize: 12, opacity: 0.75 }}>
              Consejo: cuando el cliente diga “sí”, apaga presupuesto y crea la orden.
            </div>
          )}
        </section>

        {/* A. Pedido */}
        <section style={{ marginTop: 14, padding: 14, border: '1px solid #222', borderRadius: 10 }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>A. Pedido / Presupuesto</h2>

          <div style={{ marginTop: 12, display: 'grid', gap: 10, gridTemplateColumns: '1fr 100px auto' }}>
            <select
              value={selectedProductId}
              onChange={(e) => setSelectedProductId(e.target.value === '' ? '' : Number(e.target.value))}
              style={{ padding: '10px 12px', borderRadius: 8, background: '#111', color: 'white', border: '1px solid #444' }}
            >
              <option value="">— Producto —</option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} {p.sku ? `(${p.sku})` : ''} — ${Number(p.base_price_usd ?? 0).toFixed(2)}
                </option>
              ))}
            </select>

            <input
              type="number"
              min={1}
              step={1}
              value={qty}
              onChange={(e) => setQty(Number(e.target.value))}
              style={{ padding: '10px 12px', borderRadius: 8, background: '#111', color: 'white', border: '1px solid #444' }}
            />

            <button
              type="button"
              onClick={addDraftItem}
              style={{ padding: '10px 14px', borderRadius: 8, border: 'none', background: '#22c55e', color: 'white', cursor: 'pointer' }}
            >
              + Agregar
            </button>
          </div>

          {selectedProduct && (
            <p style={{ marginTop: 8, opacity: 0.75 }}>
              Precio base: <b>{Number(selectedProduct.base_price_usd ?? 0).toFixed(2)} USD</b>
            </p>
          )}

          {draftItems.length === 0 ? (
            <p style={{ marginTop: 12, opacity: 0.75 }}>No hay items aún.</p>
          ) : (
            <div style={{ marginTop: 12, overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    {['#', 'SKU', 'Producto', 'Qty', 'P/U', 'Total', ''].map((h) => (
                      <th key={h} style={{ textAlign: 'left', borderBottom: '1px solid #333', padding: '8px 6px' }}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {draftItems.map((it, idx) => (
                    <tr key={it.localId}>
                      <td style={{ padding: '8px 6px', borderBottom: '1px solid #222' }}>{idx + 1}</td>
                      <td style={{ padding: '8px 6px', borderBottom: '1px solid #222' }}>{it.sku_snapshot ?? ''}</td>
                      <td style={{ padding: '8px 6px', borderBottom: '1px solid #222' }}>{it.product_name_snapshot}</td>
                      <td style={{ padding: '8px 6px', borderBottom: '1px solid #222' }}>
                        <input
                          type="number"
                          min={1}
                          step={1}
                          value={it.qty}
                          onChange={(e) => updateDraftQty(it.localId, Number(e.target.value))}
                          style={{ width: 70, padding: '6px 8px', borderRadius: 6, background: '#111', color: 'white', border: '1px solid #444' }}
                        />
                      </td>
                      <td style={{ padding: '8px 6px', borderBottom: '1px solid #222' }}>{Number(it.unit_price_usd_snapshot).toFixed(2)}</td>
                      <td style={{ padding: '8px 6px', borderBottom: '1px solid #222' }}>{Number(it.line_total_usd).toFixed(2)}</td>
                      <td style={{ padding: '8px 6px', borderBottom: '1px solid #222' }}>
                        <button
                          type="button"
                          onClick={() => removeDraftItem(it.localId)}
                          style={{ padding: '6px 10px', borderRadius: 6, border: 'none', background: '#ef4444', color: 'white', cursor: 'pointer' }}
                        >
                          Quitar
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <div style={{ marginTop: 10, display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                <div>Items: <b>{draftItems.length}</b></div>
                <div>Total: <b>${draftTotalUsd.toFixed(2)} USD</b></div>
              </div>

              <div style={{ marginTop: 10 }}>
                <button
                  type="button"
                  onClick={showBudget}
                  disabled={!canShowBudget}
                  style={{
                    padding: '10px 14px',
                    borderRadius: 8,
                    border: 'none',
                    background: !canShowBudget ? '#444' : '#3b82f6',
                    color: 'white',
                    cursor: !canShowBudget ? 'not-allowed' : 'pointer',
                  }}
                >
                  Presupuesto
                </button>
              </div>
            </div>
          )}
        </section>

        {/* B. Cliente */}
        <section style={{ marginTop: 14, padding: 14, border: '1px solid #222', borderRadius: 10 }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>B. Cliente (obligatorio para crear orden)</h2>
          <p style={{ opacity: 0.75, marginTop: 6 }}>Buscar por teléfono o nombre.</p>

          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <input
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Ej: +58412... o Danielis"
              style={{ flex: 1, minWidth: 220, padding: '10px 12px', borderRadius: 8, background: '#111', color: 'white', border: '1px solid #444' }}
            />

            <button
              type="button"
              onClick={() => handleSearchClients()}
              disabled={searchingClient}
              style={{ padding: '10px 14px', borderRadius: 8, border: 'none', background: '#2563eb', color: 'white', cursor: 'pointer' }}
            >
              {searchingClient ? 'Buscando…' : 'Buscar'}
            </button>

            <button
              type="button"
              onClick={activateNewClientMode}
              style={{ padding: '10px 14px', borderRadius: 8, border: 'none', background: '#f59e0b', color: '#111', cursor: 'pointer' }}
            >
              Cliente nuevo
            </button>
          </div>

          {selectedClient && (
            <div style={{ marginTop: 12, padding: 12, borderRadius: 10, background: '#0f2a1f', border: '1px solid #14532d', color: '#dcfce7' }}>
              <div><b>Cliente seleccionado:</b> {selectedClient.full_name}</div>
              <div>Teléfono: {selectedClient.phone ?? '—'}</div>
              <div>Tipo: {selectedClient.client_type ?? '—'}</div>
            </div>
          )}

          {clientResults.length > 0 && (
            <div style={{ marginTop: 12, border: '1px solid #222', borderRadius: 10, overflow: 'hidden' }}>
              {clientResults.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => selectClient(c)}
                  style={{
                    width: '100%',
                    textAlign: 'left',
                    padding: 12,
                    border: 'none',
                    borderBottom: '1px solid #222',
                    background: '#111',
                    color: 'white',
                    cursor: 'pointer',
                  }}
                >
                  <div style={{ fontWeight: 700 }}>{c.full_name}</div>
                  <div style={{ fontSize: 13, opacity: 0.75 }}>
                    Tel: {c.phone ?? '—'} | Tipo: {c.client_type ?? '—'}
                  </div>
                </button>
              ))}
            </div>
          )}

          {isNewClientMode && (
            <div style={{ marginTop: 12, padding: 12, borderRadius: 10, border: '1px solid #333', background: '#18181b' }}>
              <div style={{ fontWeight: 700, marginBottom: 10 }}>Nuevo cliente</div>

              <div style={{ display: 'grid', gap: 10 }}>
                <input
                  value={newClientName}
                  onChange={(e) => setNewClientName(e.target.value)}
                  placeholder="Nombre *"
                  style={{ padding: '10px 12px', borderRadius: 8, background: '#111', color: 'white', border: '1px solid #444' }}
                />

                <input
                  value={newClientPhone}
                  onChange={(e) => setNewClientPhone(e.target.value)}
                  placeholder="Teléfono *"
                  style={{ padding: '10px 12px', borderRadius: 8, background: '#111', color: 'white', border: '1px solid #444' }}
                />

                <select
                  value={newClientType}
                  onChange={(e) => setNewClientType(e.target.value as ClientChannelType)}
                  style={{ padding: '10px 12px', borderRadius: 8, background: '#111', color: 'white', border: '1px solid #444' }}
                >
                  <option value="assigned">assigned (asignado)</option>
                  <option value="own">own (propio)</option>
                  <option value="legacy">legacy (antiguo)</option>
                </select>

                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    onClick={createClientNow}
                    disabled={creatingClientNow}
                    style={{
                      padding: '10px 14px',
                      borderRadius: 8,
                      border: 'none',
                      background: creatingClientNow ? '#444' : '#22c55e',
                      color: 'white',
                      cursor: 'pointer',
                      fontWeight: 700,
                    }}
                  >
                    {creatingClientNow ? 'Creando…' : 'Crear cliente ahora'}
                  </button>

                  <div style={{ opacity: 0.75, display: 'flex', alignItems: 'center' }}>
                    Valida duplicado por teléfono.
                  </div>
                </div>
              </div>
            </div>
          )}
        </section>

        {/* C. Datos del pedido */}
        <section style={{ marginTop: 14, padding: 14, border: '1px solid #222', borderRadius: 10 }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>C. Datos del pedido</h2>

          <div style={{ marginTop: 12, display: 'grid', gap: 12 }}>
            {canChooseSource ? (
              <div>
                <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 6 }}>Source (quién carga)</div>
                <select
                  value={source}
                  onChange={(e) => setSource(e.target.value as OrderSource)}
                  style={{ width: '100%', padding: '10px 12px', borderRadius: 8, background: '#111', color: 'white', border: '1px solid #444' }}
                >
                  <option value="master">master</option>
                  <option value="advisor">advisor</option>
                  <option value="walk_in">walk_in</option>
                </select>
              </div>
            ) : (
              <div style={{ padding: 10, borderRadius: 8, border: '1px solid #333', background: '#111' }}>
                <div style={{ fontSize: 12, opacity: 0.75 }}>Source</div>
                <div style={{ marginTop: 4 }}><b>advisor</b> (fijado por rol)</div>
              </div>
            )}

            {canChooseAdvisor ? (
              <div>
                <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 6 }}>
                  Asesor atribuido {source === 'advisor' ? '*' : '(auto: master/admin)'}
                </div>
                <select
                  value={selectedAdvisorUserId}
                  onChange={(e) => setSelectedAdvisorUserId(e.target.value)}
                  disabled={source !== 'advisor'}
                  style={{
                    width: '100%',
                    padding: '10px 12px',
                    borderRadius: 8,
                    background: '#111',
                    color: 'white',
                    border: '1px solid #444',
                    opacity: source !== 'advisor' ? 0.6 : 1,
                  }}
                >
                  <option value="">— seleccionar asesor —</option>
                  {advisors.map((a) => (
                    <option key={a.user_id} value={a.user_id}>
                      {a.full_name}{a.is_active ? '' : ' (inactivo)'}
                    </option>
                  ))}
                </select>
                {source === 'advisor' && !selectedAdvisorUserId && (
                  <p style={{ marginTop: 6, color: '#fca5a5', fontSize: 12 }}>
                    Debes seleccionar un asesor si source=advisor.
                  </p>
                )}
              </div>
            ) : (
              <div style={{ padding: 10, borderRadius: 8, border: '1px solid #333', background: '#111' }}>
                <div style={{ fontSize: 12, opacity: 0.75 }}>Asesor atribuido</div>
                <div style={{ marginTop: 4 }}>
                  <b>{isAdvisor ? 'Autoasignado (usuario logueado)' : '—'}</b>
                </div>
              </div>
            )}

            {/* ✅ Fulfillment selector (A) */}
            <div>
              <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 6 }}>Tipo de entrega</div>
              <select
                value={fulfillment}
                onChange={(e) => setFulfillment(e.target.value as FulfillmentType)}
                style={{ width: '100%', padding: '10px 12px', borderRadius: 8, background: '#111', color: 'white', border: '1px solid #444' }}
              >
                <option value="pickup">pickup</option>
                <option value="delivery">delivery</option>
              </select>
            </div>

            {/* Status inicial */}
            <div>
              <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 6 }}>Estado inicial</div>
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value as OrderStatus)}
                style={{ width: '100%', padding: '10px 12px', borderRadius: 8, background: '#111', color: 'white', border: '1px solid #444' }}
              >
                <option value="created">created (Nuevo)</option>
                <option value="queued">queued (En cola)</option>
              </select>
              <div style={{ marginTop: 6, fontSize: 12, opacity: 0.7 }}>
                * No permitimos confirmed aquí. Confirmed se hace con “Enviar a cocina”.
              </div>
            </div>

            {/* fecha y hora */}
            <div>
              <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 6 }}>Fecha y hora</div>
              <div style={{ display: 'grid', gap: 10, gridTemplateColumns: '1fr 80px 80px 90px' }}>
                <input
                  type="date"
                  value={deliveryDate}
                  onChange={(e) => setDeliveryDate(e.target.value)}
                  style={{ padding: '10px 12px', borderRadius: 8, background: '#111', color: 'white', border: '1px solid #444' }}
                />
                <input
                  type="number"
                  min={1}
                  max={12}
                  value={deliveryHour12}
                  onChange={(e) => setDeliveryHour12(e.target.value)}
                  placeholder="Hora"
                  style={{ padding: '10px 12px', borderRadius: 8, background: '#111', color: 'white', border: '1px solid #444' }}
                />
                <input
                  type="number"
                  min={0}
                  max={59}
                  value={deliveryMinute}
                  onChange={(e) => setDeliveryMinute(e.target.value)}
                  placeholder="Min"
                  style={{ padding: '10px 12px', borderRadius: 8, background: '#111', color: 'white', border: '1px solid #444' }}
                />
                <select
                  value={deliveryAmPm}
                  onChange={(e) => setDeliveryAmPm(e.target.value as 'AM' | 'PM')}
                  style={{ padding: '10px 12px', borderRadius: 8, background: '#111', color: 'white', border: '1px solid #444' }}
                >
                  <option value="AM">AM</option>
                  <option value="PM">PM</option>
                </select>
              </div>
              <p style={{ marginTop: 6, opacity: 0.7, fontSize: 12 }}>
                Se guarda en extra_fields.schedule.
              </p>
            </div>

            {/* receptor */}
            <div style={{ display: 'grid', gap: 10, gridTemplateColumns: '1fr 1fr' }}>
              <input
                value={receiverName}
                onChange={(e) => setReceiverName(e.target.value)}
                placeholder="Quién recibe"
                style={{ padding: '10px 12px', borderRadius: 8, background: '#111', color: 'white', border: '1px solid #444' }}
              />
              <input
                value={receiverPhone}
                onChange={(e) => setReceiverPhone(e.target.value)}
                placeholder="Teléfono quien recibe"
                style={{ padding: '10px 12px', borderRadius: 8, background: '#111', color: 'white', border: '1px solid #444' }}
              />
            </div>

            {fulfillment === 'delivery' && (
              <textarea
                value={deliveryAddress}
                onChange={(e) => setDeliveryAddress(e.target.value)}
                rows={3}
                placeholder="Dirección / referencia (delivery) *"
                style={{ width: '100%', padding: '10px 12px', borderRadius: 8, background: '#111', color: 'white', border: '1px solid #444', resize: 'vertical' }}
              />
            )}

            <textarea
              value={orderNote}
              onChange={(e) => setOrderNote(e.target.value)}
              rows={3}
              placeholder="Observación general del pedido"
              style={{ width: '100%', padding: '10px 12px', borderRadius: 8, background: '#111', color: 'white', border: '1px solid #444', resize: 'vertical' }}
            />
          </div>
        </section>

        {/* D. Confirmación */}
        <section style={{ marginTop: 14, padding: 14, border: '1px solid #222', borderRadius: 10 }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>D. Confirmación</h2>

          <div style={{ marginTop: 10, display: 'grid', gap: 6 }}>
            <div>Modo: <b>{quoteOnly ? 'Presupuesto' : 'Orden'}</b></div>
            <div>Cliente: <b>{selectedClient?.full_name ?? (isNewClientMode ? 'Nuevo cliente (por crear)' : 'No seleccionado')}</b></div>
            <div>Tipo entrega: <b>{fulfillment}</b></div>
            <div>Source: <b>{source}</b></div>
            <div>
              Asesor atribuido:{' '}
              <b>
                {isAdvisor
                  ? 'Autoasignado (usuario logueado)'
                  : source === 'advisor'
                  ? (advisorSelectedLabel !== '—' ? advisorSelectedLabel : 'No seleccionado')
                  : 'Master/Admin (auto)'}
              </b>
            </div>
            <div>Total: <b>${draftTotalUsd.toFixed(2)} USD</b></div>
            <div>Estado inicial: <b>{status}</b></div>
          </div>

          <div style={{ marginTop: 12, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <button
              type="button"
              onClick={showBudget}
              disabled={!canShowBudget}
              style={{
                padding: '12px 14px',
                borderRadius: 8,
                border: 'none',
                background: !canShowBudget ? '#444' : '#3b82f6',
                color: 'white',
                cursor: !canShowBudget ? 'not-allowed' : 'pointer',
              }}
            >
              Presupuesto
            </button>

            <button
              type="submit"
              disabled={saving || !canCreateOrder}
              style={{
                padding: '12px 14px',
                borderRadius: 8,
                border: 'none',
                background: saving || !canCreateOrder ? '#444' : '#22c55e',
                color: 'white',
                cursor: saving || !canCreateOrder ? 'not-allowed' : 'pointer',
                fontWeight: 700,
              }}
            >
              {saving ? 'Guardando…' : (quoteOnly ? 'Guardar como presupuesto' : 'Crear orden')}
            </button>
          </div>

          {!hasClientSelectedOrToCreate && (
            <p style={{ marginTop: 10, color: '#fca5a5' }}>
              Para crear la orden debes seleccionar o crear un cliente.
            </p>
          )}

          {fulfillment === 'delivery' && !deliveryAddress.trim() && (
            <p style={{ marginTop: 10, color: '#fca5a5' }}>
              Para delivery, la dirección es obligatoria.
            </p>
          )}
        </section>
      </form>
    </main>
  )
}