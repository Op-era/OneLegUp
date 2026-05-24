-- ─────────────────────────────────────────────────────────────────────────────
-- One Leg Up – Full Schema
-- Run this entire file in your Supabase SQL Editor
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Members table (extends auth.users)
CREATE TABLE IF NOT EXISTS public.members (
  id            UUID        REFERENCES auth.users(id) ON DELETE CASCADE PRIMARY KEY,
  email         TEXT        NOT NULL,
  display_name  TEXT,
  profile_type  TEXT        CHECK (profile_type IN ('single_male', 'single_female', 'couple')),
  status        TEXT        DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied')),
  is_admin      BOOLEAN     DEFAULT false,
  notes         TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.members ENABLE ROW LEVEL SECURITY;

-- 2. RSVPs table (no auth required — open to anyone)
CREATE TABLE IF NOT EXISTS public.rsvps (
  id            UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  event         TEXT        NOT NULL DEFAULT 'Playboy Pool Party – May 30 2026',
  platform      TEXT,
  username      TEXT,
  profile_type  TEXT,
  contact       TEXT,
  acknowledged  BOOLEAN     DEFAULT true,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.rsvps ENABLE ROW LEVEL SECURITY;

-- 3. Admin helper (SECURITY DEFINER avoids RLS self-recursion)
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT COALESCE((SELECT is_admin FROM public.members WHERE id = auth.uid()), false);
$$;

-- 4. Members RLS
DROP POLICY IF EXISTS "select_own_or_admin"  ON public.members;
DROP POLICY IF EXISTS "insert_own"           ON public.members;
DROP POLICY IF EXISTS "update_own_or_admin"  ON public.members;
DROP POLICY IF EXISTS "delete_admin"         ON public.members;

CREATE POLICY "select_own_or_admin" ON public.members FOR SELECT USING (auth.uid() = id OR public.is_admin());
CREATE POLICY "insert_own"          ON public.members FOR INSERT WITH CHECK (auth.uid() = id);
CREATE POLICY "update_own_or_admin" ON public.members FOR UPDATE USING (auth.uid() = id OR public.is_admin());
CREATE POLICY "delete_admin"        ON public.members FOR DELETE USING (public.is_admin());

-- 5. RSVPs RLS (anyone can submit, only admin can read/delete)
DROP POLICY IF EXISTS "anon_insert_rsvp"  ON public.rsvps;
DROP POLICY IF EXISTS "admin_read_rsvps"  ON public.rsvps;
DROP POLICY IF EXISTS "admin_delete_rsvp" ON public.rsvps;

CREATE POLICY "anon_insert_rsvp"  ON public.rsvps FOR INSERT TO anon, authenticated WITH CHECK (true);
CREATE POLICY "admin_read_rsvps"  ON public.rsvps FOR SELECT USING (public.is_admin());
CREATE POLICY "admin_delete_rsvp" ON public.rsvps FOR DELETE USING (public.is_admin());

-- 6. Auto-create member row on signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO public.members (id, email, display_name, profile_type)
  VALUES (
    NEW.id,
    NEW.email,
    NEW.raw_user_meta_data->>'display_name',
    NEW.raw_user_meta_data->>'profile_type'
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- 7. Auto-update updated_at
CREATE OR REPLACE FUNCTION public.update_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS members_updated_at ON public.members;
CREATE TRIGGER members_updated_at
  BEFORE UPDATE ON public.members
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- After creating your own account, make yourself admin:
--   UPDATE public.members SET is_admin = true WHERE email = 'witprod@gmail.com';
-- ─────────────────────────────────────────────────────────────────────────────
