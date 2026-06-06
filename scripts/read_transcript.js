const fs = require('fs');
const readline = require('readline');

async function readTranscript() {
  const path = 'C:\\Users\\kalai kumar\\.gemini\\antigravity-ide\\brain\\1d77516c-1c59-4fbc-b5e1-ea3096ba6a16\\.system_generated\\logs\\transcript.jsonl';
  
  if (!fs.existsSync(path)) {
    console.error('Transcript file does not exist at:', path);
    return;
  }

  const fileStream = fs.createReadStream(path);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity
  });

  console.log('--- Reading transcript for console logs ---');
  let stepCount = 0;
  for await (const line of rl) {
    stepCount++;
    if (line.includes('capture_browser_console_logs') || line.includes('ConsoleLog') || line.includes('console_logs')) {
      try {
        const obj = JSON.parse(line);
        console.log(`\n[Step ${obj.step_index || stepCount}] Type: ${obj.type}, Status: ${obj.status}`);
        
        // Print tool call arguments
        if (obj.tool_calls) {
          console.log('Tool Calls:', JSON.stringify(obj.tool_calls, null, 2));
        }

        // Print content or output if present
        if (obj.content) {
          console.log('Content:', obj.content.slice(0, 1000));
        }
        if (obj.output) {
          const outStr = typeof obj.output === 'string' ? obj.output : JSON.stringify(obj.output);
          console.log('Output:', outStr.slice(0, 2000));
        }
      } catch (err) {
        // Fallback for non-JSON lines or parse errors
        if (line.length < 500) {
          console.log(`Raw Line: ${line}`);
        } else {
          console.log(`Raw Line (truncated): ${line.slice(0, 500)}`);
        }
      }
    }
  }
}

readTranscript().catch(console.error);
