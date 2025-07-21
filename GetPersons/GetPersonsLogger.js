const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function logToDatabase(request, started, completed, responsecode, errormessage) {
  const { error } = await supabase.from('logdata').insert([
    {
      request,
      started,
      completed,
      responsecode,
      errormessage,
    },
  ]);

  if (error) {
    console.error('Failed to insert logdata:', error.message);
  }
}

module.exports = { logToDatabase };
