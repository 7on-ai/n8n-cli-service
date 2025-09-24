// Railway N8N CLI Service - Simplified Version
import express from 'express';
import { createClient } from '@supabase/supabase-js';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';

const execAsync = promisify(exec);
const app = express();
const PORT = process.env.PORT || 3000;

// Configuration from environment variables
const CONFIG = {
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_SERVICE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY
};

// Middleware
app.use(express.json({ limit: '10mb' }));

// CORS headers for Supabase integration
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  
  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
  } else {
    next();
  }
});

// Health check endpoint (Railway requirement)
app.get('/', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    service: 'n8n-cli-railway',
    version: '1.0.0'
  });
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString() 
  });
});

// Main credential injection endpoint
app.post('/inject-credential', async (req, res) => {
  try {
    const { user_id, provider, attempt = 1 } = req.body;

    if (!user_id || !provider) {
      return res.status(400).json({
        success: false,
        message: 'Missing user_id or provider'
      });
    }

    if (!CONFIG.SUPABASE_URL || !CONFIG.SUPABASE_SERVICE_KEY) {
      return res.status(500).json({
        success: false,
        message: 'Missing Supabase configuration'
      });
    }

    console.log(`Processing credential injection (attempt ${attempt}):`, {
      userId: user_id,
      provider: provider,
      timestamp: new Date().toISOString()
    });

    // Fetch user credentials and n8n info
    const credData = await fetchUserCredentials(user_id, provider);
    if (!credData) {
      return res.status(404).json({
        success: false,
        message: 'User credentials or n8n configuration not found'
      });
    }

    // Create credential template
    const credentialTemplate = createCredentialTemplate(credData);
    const jsonContent = generateCredentialJSON([credentialTemplate]);

    // Execute n8n CLI
    const cliResult = await executeN8NCLI(credData, jsonContent);

    // Update database status
    await updateCredentialStatus(
      user_id, 
      provider, 
      cliResult.success, 
      cliResult.credentialId, 
      cliResult.message, 
      cliResult.details
    );

    if (cliResult.success) {
      return res.status(200).json({
        success: true,
        message: 'Credentials injected successfully via Railway n8n CLI',
        credential_id: cliResult.credentialId,
        details: cliResult.details
      });
    } else {
      return res.status(500).json({
        success: false,
        message: cliResult.message,
        attempt: attempt
      });
    }

  } catch (error) {
    console.error('Railway CLI Service error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Internal server error',
      error_type: 'railway_service_error'
    });
  }
});

// Fetch user credentials from Supabase
async function fetchUserCredentials(userId, provider) {
  const supabase = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_SERVICE_KEY);
  
  try {
    // Get social credentials
    const { data: socialCred, error: socialError } = await supabase
      .from('user_social_credentials')
      .select('*')
      .eq('user_id', userId)
      .eq('provider', provider)
      .single();

    if (socialError || !socialCred) {
      console.error('Social credentials not found:', socialError);
      return null;
    }

    // Get user n8n info
    const { data: userInfo, error: userError } = await supabase
      .from('launchmvpfast-saas-starterkit_user')
      .select('n8n_url, n8n_user_email, n8n_encryption_key, email, name')
      .eq('id', userId)
      .single();

    if (userError || !userInfo) {
      console.error('User n8n info not found:', userError);
      return null;
    }

    return {
      user_id: userId,
      provider: provider,
      access_token: socialCred.access_token,
      refresh_token: socialCred.refresh_token || '',
      client_id: socialCred.client_id,
      client_secret: socialCred.client_secret,
      n8n_url: userInfo.n8n_url,
      n8n_user_email: userInfo.n8n_user_email || userInfo.email,
      n8n_encryption_key: userInfo.n8n_encryption_key
    };

  } catch (error) {
    console.error('Error fetching credentials:', error);
    return null;
  }
}

// Create n8n credential template
function createCredentialTemplate(credData) {
  const credentialId = crypto.randomUUID();
  const timestamp = new Date().toISOString().slice(0, 16).replace('T', ' ');

  const credentialTypes = {
    google: 'googleOAuth2Api',
    spotify: 'spotifyOAuth2Api',
    github: 'githubOAuth2Api'
  };

  const credentialType = credentialTypes[credData.provider];
  if (!credentialType) {
    throw new Error(`Unsupported provider: ${credData.provider}`);
  }

  return {
    id: credentialId,
    name: `${credData.provider.charAt(0).toUpperCase() + credData.provider.slice(1)} OAuth2 - ${timestamp}`,
    type: credentialType,
    data: {
      clientId: credData.client_id,
      clientSecret: credData.client_secret,
      accessToken: credData.access_token,
      refreshToken: credData.refresh_token,
      tokenType: 'Bearer',
      grantType: 'authorizationCode'
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

// Generate n8n import JSON
function generateCredentialJSON(credentials) {
  return JSON.stringify({
    version: "1.0.0",
    credentials: credentials,
    workflows: []
  }, null, 2);
}

// Execute n8n CLI (Railway optimized)
async function executeN8NCLI(credData, jsonContent) {
  const tempFileName = `credentials-${Date.now()}.json`;
  const tempFilePath = path.join('/tmp', tempFileName);
  
  try {
    console.log('Starting Railway n8n CLI execution');

    // Write JSON file
    await fs.writeFile(tempFilePath, jsonContent);

    // Set n8n environment
    const env = {
      ...process.env,
      N8N_ENCRYPTION_KEY: credData.n8n_encryption_key,
      N8N_USER_MANAGEMENT_DISABLED: 'false',
      N8N_LOG_LEVEL: 'warn'
    };

    // Import credentials
    const { stdout, stderr } = await execAsync(
      `n8n import:credentials --input=${tempFilePath} --separate`, 
      { env, timeout: 30000 }
    );
    
    console.log('CLI output:', stdout);
    if (stderr) console.log('CLI stderr:', stderr);

    // Cleanup
    await fs.unlink(tempFilePath).catch(() => {});

    const credentialId = JSON.parse(jsonContent).credentials[0].id;
    
    return {
      success: true,
      credentialId: credentialId,
      message: 'Credentials imported successfully via Railway',
      details: {
        method: 'railway_cli',
        output: stdout
      }
    };

  } catch (error) {
    console.error('Railway CLI execution error:', error);
    await fs.unlink(tempFilePath).catch(() => {});
    
    return {
      success: false,
      message: error.message || 'Railway CLI execution failed'
    };
  }
}

// Update database status
async function updateCredentialStatus(userId, provider, success, credentialId, error, details) {
  const supabase = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_SERVICE_KEY);
  
  const updateData = {
    injected_to_n8n: success,
    injected_at: success ? new Date().toISOString() : null,
    injection_error: error || null,
    additional_data: JSON.stringify({
      injection_method: 'railway_cli',
      success: success,
      error: error || null,
      details: details || null,
      timestamp: new Date().toISOString(),
      platform: 'railway'
    }),
    updated_at: new Date().toISOString()
  };

  if (credentialId) {
    updateData.n8n_credential_id = credentialId;
  }

  const { error: updateError } = await supabase
    .from('user_social_credentials')
    .update(updateData)
    .eq('user_id', userId)
    .eq('provider', provider);

  if (updateError) {
    console.error('Failed to update credential status:', updateError);
    throw new Error(`Database update failed: ${updateError.message}`);
  }
}

// Start server
app.listen(PORT, () => {
  console.log(`Railway N8N CLI Service running on port ${PORT}`);
  console.log('Environment check:', {
    hasSupabaseUrl: !!CONFIG.SUPABASE_URL,
    hasSupabaseKey: !!CONFIG.SUPABASE_SERVICE_KEY,
    nodeVersion: process.version,
    port: PORT
  });
});
