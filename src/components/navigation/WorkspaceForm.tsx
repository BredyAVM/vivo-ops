'use client';
import { usePathname } from 'next/navigation';
import type { ComponentProps } from 'react';
import { adminWorkspaceHref } from '@/lib/navigation/admin-workspace';
import { ReturnContextField } from './BackLink';

// GET filters stay in the current workspace. Server Actions are passed unchanged.
export default function WorkspaceForm({ action, ...props }: ComponentProps<'form'>) {
  const pathname = usePathname();
  return <form {...props} action={typeof action === 'string' ? adminWorkspaceHref(action, pathname) : action}>
    {props.method?.toLowerCase() === 'get' ? <ReturnContextField /> : null}
    {props.children}
  </form>;
}
