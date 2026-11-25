import { createClient } from "@supabase/supabase-js";

// Both values are public by design: the publishable key only identifies the
// project, and row security on the database decides what a user can read.
const SUPABASE_URL = "https://hmevfdykiyglpwmwbpau.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_5uJdTVe8rr1PIv6mwIUeTQ_21JS1_Jn";

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
