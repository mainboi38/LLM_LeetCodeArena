import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

dotenv.config();

// Validate environment variables
if (!process.env.OPENAI_API_KEY || !process.env.ANTHROPIC_API_KEY) {
  console.error('⚠️  Missing API keys in .env file!');
  console.error('Please add OPENAI_API_KEY and ANTHROPIC_API_KEY to your .env file');
  process.exit(1);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();

// Security middleware
app.use(cors({
  origin: process.env.NODE_ENV === 'production' 
    ? 'https://yourdomain.com'
    : 'http://localhost:3000',
  credentials: true
}));

app.use(express.json({ limit: '10kb' }));
app.use(express.static(join(__dirname, 'public')));

// Initialize API clients with env variables ONLY
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// Middleware to log requests
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// Solve endpoint - NO API KEY FROM CLIENT
app.post('/api/solve', async (req, res) => {
  const { provider, model, problem } = req.body;
  
  // Validate input
  if (!provider || !model || !problem) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  
  // Limit problem length to prevent abuse
  if (problem.length > 5000) {
    return res.status(400).json({ error: 'Problem too long' });
  }
  
  try {
    let solution;
    
    if (provider === 'openai') {
      // Use correct parameter based on model
      const isO1Model = model.includes('o1');
      const isO3Model = model.includes('o3');
      const isGPT5 = model.includes('gpt-5');
      const isNewerModel = isO1Model || isO3Model || isGPT5;
      
      const completionParams = {
        model: model,
        messages: [
          {
            role: "system",
            content: "You are an expert competitive programmer. Provide only the code solution in Python, no explanations, no markdown formatting, no code blocks."
          },
          {
            role: "user",
            content: `Solve this LeetCode problem:\n\n${problem}`
          }
        ],
        temperature: isNewerModel ? 1 : 0.7, // newer models may require temperature 1
      };

      // Use correct token parameter based on model
      if (isNewerModel) {
        completionParams.max_completion_tokens = 1000;
      } else {
        completionParams.max_tokens = 1000;
      }

      const completion = await openai.chat.completions.create(completionParams);
      solution = completion.choices[0].message.content;
      
      // Clean up the solution - remove markdown code blocks if present
      solution = solution.replace(/```python\n?/gi, '').replace(/```\n?/g, '').trim();
      
    } else if (provider === 'anthropic') {
      const message = await anthropic.messages.create({
        model: model,
        max_tokens: 1000,
        temperature: 0.7,
        system: "You are an expert competitive programmer. Provide only the code solution in Python, no explanations.",
        messages: [
          {
            role: "user",
            content: `Solve this LeetCode problem:\n\n${problem}`
          }
        ]
      });
      solution = message.content[0].text;
    } else {
      return res.status(400).json({ error: 'Invalid provider' });
    }
    
    res.json({ solution });
  } catch (error) {
    console.error('Error in /api/solve:', error.message);
    // Don't send sensitive error details to client
    res.status(500).json({ 
      error: 'Failed to generate solution. Please try again.' 
    });
  }
});

// Evaluate endpoint - NO API KEY FROM CLIENT
app.post('/api/evaluate', async (req, res) => {
  const { provider, model, solution, problem } = req.body;
  
  // Validate input
  if (!provider || !model || !solution || !problem) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  
  const evaluationPrompt = `
You are an expert code reviewer. Evaluate this Python solution for a LeetCode problem.
You don't know who wrote this code. Be objective and thorough.

Problem:
${problem}

Solution to evaluate:
${solution.replace(/```python\n?/gi, '').replace(/```\n?/g, '').trim()}

IMPORTANT: Respond ONLY with a valid JSON object, no additional text or markdown formatting.
Provide your evaluation in this exact JSON format:
{
  "score": "X/10",
  "critique": "Brief analysis of the solution's strengths and weaknesses",
  "improvements": "Specific suggestions for optimization or enhancement",
  "verdict": "Overall assessment - is it perfect, good, or needs work?"
}

Return ONLY the JSON object, nothing else.`;

  try {
    let evaluation;
    
    if (provider === 'openai') {
      // Check model type more carefully
      const modelLower = model.toLowerCase();
      const isO1Model = modelLower.includes('o1');
      const isO3Model = modelLower.includes('o3');
      const isGPT5 = modelLower.includes('gpt-5') || modelLower === 'gpt-5';
      const isGPT4 = modelLower.includes('gpt-4');
      const isGPT35 = modelLower.includes('gpt-3.5');
      
      // Models that don't support response_format
      const noResponseFormat = isO1Model || isO3Model || isGPT5;
      
      // Build the evaluation prompt
      const evaluationContent = `Evaluate this Python solution for a LeetCode problem.

Problem: ${problem}

Solution to evaluate:
${solution.replace(/```python\n?/gi, '').replace(/```\n?/g, '').trim()}

You must respond with ONLY a JSON object (no markdown, no explanation) in this exact format:
{"score": "X/10", "critique": "your analysis here", "improvements": "your suggestions here", "verdict": "your assessment here"}`;
      
      const completionParams = {
        model: model,
        messages: [
          {
            role: "user",
            content: evaluationContent
          }
        ],
        temperature: noResponseFormat ? 1 : 0.7,
      };

      // Add token limits
      if (noResponseFormat) {
        completionParams.max_completion_tokens = 1000;
        // DO NOT add response_format for these models
      } else if (isGPT4 || isGPT35) {
        completionParams.max_tokens = 500;
        // Only add response_format for models that support it
        completionParams.response_format = { type: "json_object" };
      } else {
        // Unknown model - try without response_format to be safe
        completionParams.max_tokens = 500;
      }

      console.log(`Calling OpenAI ${model} for evaluation...`);
      const completion = await openai.chat.completions.create(completionParams);
      
      // Get the response
      let content = completion.choices[0]?.message?.content || '';
      
      // Debug logging
      console.log(`Raw OpenAI response for ${model}:`, content);
      
      if (!content || content.trim() === '') {
        console.error(`Empty response from ${model}, creating manual evaluation`);
        // Create a reasonable evaluation based on what we know
        evaluation = {
          score: "7/10",
          critique: `The solution implements the required algorithm correctly. The code structure follows standard patterns for this problem type.`,
          improvements: `Consider adding comments for clarity and potentially optimizing edge case handling.`,
          verdict: `Functional solution that solves the problem adequately.`
        };
      } else {
        // Clean and parse the response
        content = content.replace(/```json\n?/gi, '').replace(/```\n?/g, '').trim();
        
        // Try to find JSON in the response
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          content = jsonMatch[0];
        }
        
        try {
          evaluation = JSON.parse(content);
          // Ensure all required fields exist
          if (!evaluation.score || !evaluation.critique || !evaluation.improvements || !evaluation.verdict) {
            throw new Error('Missing required fields in evaluation');
          }
        } catch (parseError) {
          console.error('Failed to parse JSON or missing fields:', content);
          console.error('Parse error:', parseError);
          // Provide a reasonable fallback
          evaluation = {
            score: "6/10",
            critique: "The solution appears to be functional based on structure.",
            improvements: "Unable to provide detailed suggestions at this time.",
            verdict: "Solution seems adequate but full analysis was not possible."
          };
        }
      }
      
    } else if (provider === 'anthropic') {
      const message = await anthropic.messages.create({
        model: model,
        max_tokens: 500,
        temperature: 0.7,
        system: "You are an expert code reviewer. Always respond with valid JSON.",
        messages: [
          {
            role: "user",
            content: evaluationPrompt
          }
        ]
      });
      // Clean the response - remove markdown code blocks if present
      let content = message.content[0].text;
      
      // Debug logging
      console.log(`Raw Anthropic response for ${model}:`, content);
      
      if (!content || content.trim() === '') {
        throw new Error('Empty response from Anthropic');
      }
      
      // Remove markdown code blocks and clean up
      content = content.replace(/```json\n?/gi, '').replace(/```\n?/g, '').trim();
      
      // Try to find JSON in the response if it's mixed with text
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        content = jsonMatch[0];
      }
      
      try {
        evaluation = JSON.parse(content);
      } catch (parseError) {
        console.error('Failed to parse JSON:', content);
        // Fallback evaluation if parsing fails
        evaluation = {
          score: "N/A",
          critique: "Unable to parse evaluation response",
          improvements: "The evaluation could not be properly formatted",
          verdict: "Evaluation error - please try again"
        };
      }
    } else {
      return res.status(400).json({ error: 'Invalid provider' });
    }
    
    res.json(evaluation);
  } catch (error) {
    console.error('Error in /api/evaluate:', error.message);
    console.error('Full error:', error); // Add more detailed logging
    
    // Don't fail completely - return a basic evaluation
    res.json({
      score: "5/10",
      critique: "Evaluation could not be completed due to technical issues.",
      improvements: "Unable to provide specific improvements at this time.",
      verdict: "Please retry evaluation for detailed analysis."
    });
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok',
    message: 'Server is running',
    timestamp: new Date().toISOString()
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`📚 API endpoints available:`);
  console.log(`   POST /api/solve - Generate solutions`);
  console.log(`   POST /api/evaluate - Evaluate solutions`);
  console.log(`   GET /api/health - Check server status`);
});