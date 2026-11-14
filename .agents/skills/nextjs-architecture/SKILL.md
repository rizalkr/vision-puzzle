---
name: nextjs-architecture
description: Next.js (App Router) architecture and best-practice guidance. Use when building new Next.js features, deciding between Server and Client Components, writing Server Actions or Route Handlers, structuring data fetching, validation, auth, and caching, or refactoring bloated components and pages.
---

# Next.js Architecture & Best Practices (App Router)

## Before Writing Code
1. Check `package.json` for the Next.js and React versions, then confirm the project uses the App Router (`app/`) and not the Pages Router (`pages/`).
2. Detect existing conventions: language (TS/JS), validation library (Zod, Valibot), ORM (Prisma, Drizzle), auth library, UI kit, folder layout. Follow them.
3. Version-sensitive behavior (verify against the installed version or the official docs when unsure):
   - Next 15+: `params`, `searchParams`, `cookies()`, and `headers()` are async and must be awaited.
   - Next 15+: `fetch` requests and GET Route Handlers are not cached by default.
   - Next 16: caching is opt-in via `use cache`, and `middleware.ts` is renamed `proxy.ts`.
4. Pick the simplest approach that fits the task.

## When to Use What
| Situation | Approach |
|---|---|
| Reading data for a page | Server Component fetching directly (via a data-access function) |
| Mutation triggered by your own UI (form, button) | Server Action |
| Endpoint for external clients, webhooks, mobile apps | Route Handler (`route.ts`) |
| Interactivity, browser APIs, local state, effects | Client Component (`'use client'`) |
| Client-side polling, optimistic UX, shared client cache | TanStack Query/SWR, only if really needed |
| Heavy or slow side effects | Queue/background job, not inside the request |

Principle: default to Server Components. Add `'use client'` only at the smallest leaf that needs it.

## Core Principles
1. **Server by default.** Server Components cut client JS and keep secrets on the server. Push `'use client'` down to small leaves (a button, a form field), not whole pages or layouts.
2. **Thin route files.** `page.tsx`, `layout.tsx`, and `route.ts` compose and delegate. Business logic lives in separate modules (`lib/`, `features/<name>/`), so it is testable and reusable.
3. **Data Access Layer.** Put DB and external API calls in server-only functions (e.g. `lib/data/users.ts`) marked with `import 'server-only'`. Authorize inside these functions, not only in the UI.
4. **Validate every input on the server.** Parse `FormData`, JSON bodies, `params`, and `searchParams` with Zod (or equivalent). Types alone do not validate runtime data.
5. **Treat Server Actions as public endpoints.** Anyone can call them directly. Always authenticate, authorize, and validate inside each action.
6. **Return only what the client needs.** Map DB rows to small DTOs before passing to Client Components. Never pass full records, password hashes, or internal fields as props.
7. **Be explicit about caching and revalidation.** After mutations call `revalidatePath` or `revalidateTag`; don't rely on defaults you haven't verified for this version.

## Suggested Structure (adapt to the project)
```
app/
  (routes)/orders/page.tsx        # composes, no business logic
  api/webhooks/stripe/route.ts    # external-facing only
features/orders/
  actions.ts                      # 'use server' mutations
  queries.ts                      # server-only data access
  schemas.ts                      # Zod schemas + inferred types
  components/                     # UI for this feature
lib/
  auth.ts  db.ts  env.ts
```

## Security & Performance Checklist
- Auth and authorization checks in every Server Action, Route Handler, and data-access function. Don't rely on `proxy.ts`/middleware alone.
- Only `NEXT_PUBLIC_*` env vars reach the browser. Never put secrets in them. Validate env vars at startup (`lib/env.ts`).
- Use `import 'server-only'` on modules that touch secrets or the DB.
- Avoid request waterfalls: run independent fetches with `Promise.all`, and use `<Suspense>` with `loading.tsx` for slow sections.
- Use `next/image`, `next/font`, and dynamic imports for heavy client-only libraries.
- Never trust client-supplied IDs or prices; re-derive from the database.
- Don't expose raw error messages or stack traces to the client.

## Examples

Bad (client-fetching, no validation, logic in the component):
```tsx
'use client'
export default function Orders() {
  const [orders, setOrders] = useState([])
  useEffect(() => {
    fetch('/api/orders').then(r => r.json()).then(setOrders)
  }, [])
  return <List items={orders} />
}
```

Good (server fetch via data-access layer):
```tsx
// app/orders/page.tsx
import { getOrdersForCurrentUser } from '@/features/orders/queries'
import { OrderList } from '@/features/orders/components/order-list'

export default async function OrdersPage() {
  const orders = await getOrdersForCurrentUser()
  return <OrderList orders={orders} />
}
```

```ts
// features/orders/queries.ts
import 'server-only'
import { requireUser } from '@/lib/auth'
import { db } from '@/lib/db'

export async function getOrdersForCurrentUser() {
  const user = await requireUser()
  const rows = await db.order.findMany({ where: { userId: user.id } })
  return rows.map(({ id, total, status }) => ({ id, total, status })) // DTO
}
```

Good Server Action (auth + validation + revalidation):
```ts
// features/orders/actions.ts
'use server'
import { revalidatePath } from 'next/cache'
import { requireUser } from '@/lib/auth'
import { createOrderSchema } from './schemas'
import { createOrder } from './queries'

export async function createOrderAction(_prev: unknown, formData: FormData) {
  const user = await requireUser()
  const parsed = createOrderSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) {
    return { ok: false as const, errors: parsed.error.flatten().fieldErrors }
  }
  await createOrder(user.id, parsed.data)
  revalidatePath('/orders')
  return { ok: true as const }
}
```

## Output Format (adapt to the task type)
- **New feature:** (1) files to create/change, (2) Zod schema, (3) data-access functions, (4) Server Action or Route Handler, (5) page/components (state which are Server vs Client and why), (6) caching/revalidation notes.
- **Refactor:** point out the issue (e.g. unnecessary `'use client'`, client-side fetching, missing validation), show the result per file, and note any behavior change.
- **Architecture question:** give a recommendation with trade-offs; code only where it clarifies.

## Avoid
- Marking whole pages or layouts `'use client'` to fix one hook error.
- Calling your own Route Handlers from Server Components; call the data function directly.
- Using Server Actions for data fetching (they are for mutations).
- Passing unvalidated `FormData` or `searchParams` straight to the database.
- Adding global state libraries, repositories, or abstraction layers without a concrete need.
- Writing code for the Pages Router (`getServerSideProps`, etc.) in an App Router project, or vice versa.
- Assuming caching behavior without checking the installed Next.js version.