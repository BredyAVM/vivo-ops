'use client';

import { useState } from 'react';
import { createSupabaseBrowser } from '@/lib/supabase';
import { useRouter } from 'next/navigation';

export default function LoginForm() {
  const router = useRouter();
  const supabase = createSupabaseBrowser();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  async function signIn() {
    try {
      setLoading(true);
      setErrorMessage('');

      const { error } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });

      if (error) {
        setErrorMessage(error.message);
        return;
      }

      router.push('/');
      router.refresh();
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="min-h-screen bg-[#0B0B0D] text-[#F5F5F7]">
      <div className="mx-auto flex min-h-screen max-w-[420px] items-center px-6">
        <div className="w-full rounded-3xl border border-[#242433] bg-[#121218] p-6 shadow-2xl">
          <div className="text-2xl font-semibold">VIVO OPS</div>
          <div className="mt-1 text-sm text-[#B7B7C2]">
            Inicia sesión para entrar al sistema
          </div>

          <div className="mt-6 space-y-4">
            <div>
              <label className="mb-1 block text-xs text-[#8A8A96]">Correo</label>
              <input
                placeholder="tucorreo@ejemplo.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                className="w-full rounded-2xl border border-[#242433] bg-[#0B0B0D] px-4 py-3 text-sm text-[#F5F5F7] placeholder:text-[#6F6F7C] outline-none"
              />
            </div>

            <div>
              <label className="mb-1 block text-xs text-[#8A8A96]">Contraseña</label>
              <input
                placeholder="Tu contraseña"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                className="w-full rounded-2xl border border-[#242433] bg-[#0B0B0D] px-4 py-3 text-sm text-[#F5F5F7] placeholder:text-[#6F6F7C] outline-none"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !loading) {
                    signIn();
                  }
                }}
              />
            </div>

            {errorMessage ? (
              <div className="rounded-2xl border border-red-500/30 bg-[#17090A] px-4 py-3 text-sm text-red-300">
                {errorMessage}
              </div>
            ) : null}

            <button
              onClick={signIn}
              disabled={loading}
              className={[
                'w-full rounded-2xl px-4 py-3 text-sm font-semibold',
                loading
                  ? 'bg-[#2A2A38] text-[#8A8A96]'
                  : 'bg-[#FEEF00] text-[#0B0B0D]',
              ].join(' ')}
            >
              {loading ? 'Entrando...' : 'Entrar'}
            </button>
          </div>
        </div>
      </div>
    </main>
  );
}
