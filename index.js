// Railway N8N CLI Service - Fixed Version with Proper CLI Handling
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

// Health check endpoint with n8n CLI verification
app.get('/', async (req, res) => {
  try {
    // Test n8n CLI availability
    const { stdout } = await execAsync('n8n --version', { timeout: 5000 });
    
    res.json({ 
      status: 'healthy', 
      timestamp: new Date().toISOString(),
      service: 'n8n-cli-railway',
      version: '2.0.0',
      n8n_cli_version: stdout.trim(),
      n8n_available: true
    });
  } catch (error) {
    res.status(500).json({
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      service: 'n8n-cli-railway',
      error: 'n8n CLI not available',
      details: error.message,
      n8n_available: false
    });
  }
});

app.get('/health', async (req, res) => {
  try {
    // Verify n8n CLI commands are available
    const { stdout } = await execAsync('n8n --help', { timeout: 5000 });
    const hasImportCommand = stdout.includes('import:credentials');
    
    res.json({ 
      status: 'ok', 
      timestamp: new Date().toISOString(),
      n8n_cli_available: true,
      import_command_available: hasImportCommand
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      timestamp: new Date().toISOString(),
      error: 'n8n CLI check failed',
      details: error.message,
      n8n_cli_available: false
    });
  }
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

    // Verify n8n CLI before proceeding
    try {
      await execAsync('n8n --version', { timeout: 5000 });
    } catch (cliError) {
      console.error('N8N CLI not available:', cliError);
      return res.status(500).json({
        success: false,
        message: 'N8N CLI is not available in this environment',
        error_type: 'cli_unavailable'
      });
    }

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

    // Execute n8n CLI with enhanced error handling
    const cliResult = await executeN8NCLIEnhanced(credData, jsonContent);

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
        attempt: attempt,
        troubleshooting: cliResult.troubleshooting
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

// Enhanced n8n CLI execution with multiple strategies
async function executeN8NCLIEnhanced(credData, jsonContent) {
  const tempFileName = `credentials-${Date.now()}.json`;
  const tempFilePath = path.join('/tmp', tempFileName);
  
  try {
    console.log('Starting enhanced Railway n8n CLI execution');

    // Write JSON file
    await fs.writeFile(tempFilePath, jsonContent);

    // Strategy 1: Try basic import command
    try {
      console.log('Attempting Strategy 1: Basic import command');
      
      const result = await tryImportCommand(tempFilePath, credData, 'basic');
      if (result.success) {
        await fs.unlink(tempFilePath).catch(() => {});
        return result;
      }
    } catch (error) {
      console.log('Strategy 1 failed:', error.message);
    }

    // Strategy 2: Try with explicit user folder
    try {
      console.log('Attempting Strategy 2: With explicit user folder');
      
      // Create user folder
      await fs.mkdir('/tmp/.n8n', { recursive: true });
      
      const result = await tryImportCommand(tempFilePath, credData, 'userFolder');
      if (result.success) {
        await fs.unlink(tempFilePath).catch(() => {});
        return result;
      }
    } catch (error) {
      console.log('Strategy 2 failed:', error.message);
    }

    // Strategy 3: Try with minimal environment
    try {
      console.log('Attempting Strategy 3: Minimal environment');
      
      const result = await tryImportCommand(tempFilePath, credData, 'minimal');
      if (result.success) {
        await fs.unlink(tempFilePath).catch(() => {});
        return result;
      }
    } catch (error) {
      console.log('Strategy 3 failed:', error.message);
    }

    throw new Error('All import strategies failed');

  } catch (error) {
    console.error('Enhanced CLI execution error:', error);
    await fs.unlink(tempFilePath).catch(() => {});
    
    return {
      success: false,
      message: error.message || 'Enhanced CLI execution failed',
      troubleshooting: {
        strategies_tried: ['basic', 'userFolder', 'minimal'],
        common_fixes: [
          'Rebuild Docker image with proper n8n installation',
          'Check n8n global installation',
          'Verify file permissions in container'
        ]
      }
    };
  }
}

// Try different import command strategies
async function tryImportCommand(tempFilePath, credData, strategy) {
  let command;
  let env = { ...process.env };

  switch (strategy) {
    case 'basic':
      command = `n8n import:credentials --input=${tempFilePath}`;
      env.N8N_ENCRYPTION_KEY = credData.n8n_encryption_key;
      break;
      
    case 'userFolder':
      command = `n8n import:credentials --input=${tempFilePath} --userFolder=/tmp/.n8n`;
      env.N8N_ENCRYPTION_KEY = credData.n8n_encryption_key;
      env.N8N_USER_FOLDER = '/tmp/.n8n';
      break;
      
    case 'minimal':
      command = `n8n import:credentials --input=${tempFilePath}`;
      env = {
        NODE_ENV: 'production',
        N8N_ENCRYPTION_KEY: credData.n8n_encryption_key,
        N8N_LOG_LEVEL: 'error',
        N8N_USER_MANAGEMENT_DISABLED: 'true'
      };
      break;
      
    default:
      throw new Error(`Unknown strategy: ${strategy}`);
  }

  console.log(`Executing: ${command}`);
  console.log(`Environment: N8N_ENCRYPTION_KEY=${env.N8N_ENCRYPTION_KEY ? 'set' : 'not set'}`);

  const { stdout, stderr } = await execAsync(command, { 
    env, 
    timeout: 60000,
    cwd: '/tmp'
  });
  
  console.log(`Strategy ${strategy} output:`, stdout);
  if (stderr) console.log(`Strategy ${strategy} stderr:`, stderr);

  // Check for success indicators
  if (stdout.includes('Successfully imported') || 
      stdout.includes('imported') || 
      stdout.includes('credential')) {
    
    const credentialId = JSON.parse(await fs.readFile(tempFilePath, 'utf8')).credentials[0].id;
    
    return {
      success: true,
      credentialId: credentialId,
      message: `Credentials imported successfully using ${strategy} strategy`,
      details: {
        method: `railway_cli_${strategy}`,
        output: stdout,
        strategy: strategy
      }
    };
  }

  throw new Error(`Import command completed but no success indicators found. Output: ${stdout}`);
}

// Keep other functions unchanged
async function fetchUserCredentials(userId, provider) {
  const supabase = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_SERVICE_KEY);
  
  try {
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

function generateCredentialJSON(credentials) {
  return JSON.stringify({
    version: "1.0.0",
    credentials: credentials,
    workflows: []
  }, null, 2);
}

async function updateCredentialStatus(userId, provider, success, credentialId, error, details) {
  const supabase = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_SERVICE_KEY);
  
  const updateData = {
    injected_to_n8n: success,
    injected_at: success ? new Date().toISOString() : null,
    injection_error: error || null,
    additional_data: JSON.stringify({
      injection_method: 'railway_cli_enhanced',
      success: success,
      error: error || null,
      details: details || null,
      timestamp: new Date().toISOString(),
      platform: 'railway',
      version: '2.0'
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
  console.log(`Railway N8N CLI Service v2.0 running on port ${PORT}`);
  console.log('Environment check:', {
    hasSupabaseUrl: !!CONFIG.SUPABASE_URL,
    hasSupabaseKey: !!CONFIG.SUPABASE_SERVICE_KEY,
    nodeVersion: process.version,
    port: PORT
  });
});
