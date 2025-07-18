import type { Express } from "express";
import express from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage-pg";
import { billingStorage } from "./billing-storage";
import { insertExpenseSchema, loginSchema, signUpSchema } from "@shared/schema";
import bcrypt from "bcrypt";
import { supabase } from "./supabase";
import session from "express-session";
import { z } from "zod";

declare module "express-session" {
  interface SessionData {
    userId?: number;
    userRole?: string;
  }
}

export async function registerRoutes(app: Express): Promise<Server> {
  // Session configuration
  app.use(session({
    secret: process.env.SESSION_SECRET || "your-secret-key",
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: false, // Always false to work in dev and production
      httpOnly: true,
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
      sameSite: 'lax',
    },
  }));

  // Authentication middleware
  const requireAuth = (req: any, res: any, next: any) => {
    if (!req.session.userId) {
      return res.status(401).json({ message: "Authentication required" });
    }
    next();
  };

  const requireAdmin = (req: any, res: any, next: any) => {
    if (!req.session.userId || req.session.userRole !== "admin") {
      return res.status(403).json({ message: "Admin access required" });
    }
    next();
  };

  // Auth routes
  app.post("/api/auth/login", async (req, res) => {
    try {
      const { email, password } = loginSchema.parse(req.body);

      const user = await storage.getUserByEmail(email);
      if (!user) {
        return res.status(401).json({ message: "Credenciais inválidas" });
      }

      // Todos os usuários agora usam Supabase Auth
      const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (authError || !authData.user) {
        return res.status(401).json({ message: "Credenciais inválidas" });
      }

      // Se o usuário tem authUid, verificar correspondência
      if (user.authUid && authData.user.id !== user.authUid) {
        return res.status(401).json({ message: "Credenciais inválidas" });
      }

      // Se o usuário não tem authUid (usuários tradicionais migrados), atualizar com o authUid do Supabase
      if (!user.authUid) {
        await storage.updateUserAuthUid(user.id, authData.user.id);
      }

      req.session.userId = user.id;
      req.session.userRole = user.role;

      res.json({
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
      });
    } catch (error: any) {
      console.error("Login error:", error);
      res.status(400).json({ message: "Dados de requisição inválidos" });
    }
  });

  app.post("/api/auth/signup", requireAdmin, async (req, res) => {
    try {
      const { email, password, name, role } = signUpSchema.parse(req.body);

      // Verificar se já existe usuário na nossa tabela
      const existingUser = await storage.getUserByEmail(email);
      if (existingUser) {
        return res.status(400).json({ message: "Email já está em uso" });
      }

      // 1. Criar usuário no Supabase Auth
      const { data: authData, error: authError } = await supabase.auth.admin.createUser({
        email,
        password,
        email_confirm: true
      });

      if (authError) {
        console.error("Erro detalhado do Supabase Auth:", authError);

        // Se o erro for de email já existente, vamos buscar o usuário existente
        if (authError.message.includes("already been registered")) {
          // Obter lista de usuários para encontrar o authUid
          const { data: listData, error: listError } = await supabase.auth.admin.listUsers();
          if (listError) {
            return res.status(400).json({ message: "Erro ao verificar usuários existentes" });
          }

          const existingAuthUser = listData.users.find(u => u.email === email);
          if (!existingAuthUser) {
            return res.status(400).json({ message: "Erro de consistência: usuário existe no auth mas não foi encontrado" });
          }

          // Criar apenas o registro na nossa tabela usando o authUid existente
          const user = await storage.createUserWithAuth({
            authUid: existingAuthUser.id,
            email,
            name,
            role,
          });

          return res.json({
            id: user.id,
            email: user.email,
            name: user.name,
            role: user.role,
            authUid: user.authUid,
          });
        }

        return res.status(400).json({ message: `Erro no Supabase Auth: ${authError.message}` });
      }

      if (!authData.user) {
        return res.status(400).json({ message: "Falha ao criar usuário no Supabase Auth" });
      }

      // 2. Criar registro na tabela users com o auth_uid
      const user = await storage.createUserWithAuth({
        authUid: authData.user.id,
        email,
        name,
        role,
      });

      res.json({
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        authUid: user.authUid,
      });
    } catch (error: any) {
      console.error("Signup error:", error);
      if (error.code === "23505") { // Unique constraint violation
        return res.status(400).json({ message: "Email já está em uso" });
      }
      if (error.code === "23502") { // Not null constraint violation
        return res.status(400).json({ message: "Erro de configuração do banco de dados" });
      }
      res.status(400).json({ message: "Dados de requisição inválidos" });
    }
  });

  app.post("/api/auth/logout", (req, res) => {
    req.session.destroy((err) => {
      if (err) {
        return res.status(500).json({ message: "Could not log out" });
      }
      res.json({ message: "Logged out successfully" });
    });
  });

  app.get("/api/auth/me", requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }

      res.json({
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
      });
    } catch (error) {
      res.status(500).json({ message: "Server error" });
    }
  });

  // Get user by ID route
  app.get("/api/users/:id", requireAuth, async (req, res) => {
    try {
      const userId = parseInt(req.params.id);
      if (isNaN(userId)) {
        return res.status(400).json({ message: "ID de usuário inválido" });
      }

      const user = await storage.getUser(userId);
      if (!user) {
        return res.status(404).json({ message: "Usuário não encontrado" });
      }

      // Retornar apenas dados necessários (sem senha)
      res.json({
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role
      });
    } catch (error) {
      console.error("Erro ao buscar usuário:", error);
      res.status(500).json({ message: "Erro interno do servidor" });
    }
  });

  // Image upload route - Supabase Storage
  app.post("/api/upload", requireAuth, async (req, res) => {
    try {
      console.log('=== DEBUG UPLOAD ===');
      console.log('Usuário ID:', req.session.userId);
      console.log('Função do usuário:', req.session.userRole);
      console.log('Body recebido:', req.body ? 'Presente' : 'Ausente');
      
      if (!req.body || !req.body.file || !req.body.filename) {
        console.log('Erro: Dados faltando no body');
        return res.status(400).json({ message: "Arquivo e nome do arquivo são obrigatórios" });
      }

      const { file: fileData, filename } = req.body;
      const userId = req.session.userId;

      if (!userId) {
        console.log('Erro: Usuário não autenticado');
        return res.status(401).json({ message: "Usuário não autenticado" });
      }

      // Converter base64 para buffer
      const base64Data = fileData.replace(/^data:image\/\w+;base64,/, '');
      const buffer = Buffer.from(base64Data, 'base64');

      const fileExt = filename.split('.').pop();
      const fileName = `${userId}_${Date.now()}.${fileExt}`;
      const filePath = `${fileName}`;

      // Verificar/criar bucket usando apenas a API de Storage
      try {
        const { data: buckets } = await supabase.storage.listBuckets();
        const receiptsBucket = buckets?.find(bucket => bucket.name === 'receipts');

        if (!receiptsBucket) {
          await supabase.storage.createBucket('receipts', { 
            public: true,
            allowedMimeTypes: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'],
            fileSizeLimit: 5242880
          });
        }
      } catch (bucketError) {
        // Continue com upload mesmo se verificação do bucket falhar
      }

      // Verificar se o usuário existe no sistema
      const currentUser = await storage.getUser(userId);
      if (!currentUser) {
        console.log('Erro: Usuário não encontrado');
        return res.status(400).json({ message: "Usuário não encontrado" });
      }
      
      // Log para debug - não bloquear upload se authUid não existir
      if (!currentUser.authUid) {
        console.log('Aviso: Usuário não tem authUid - upload pode falhar por políticas RLS');
      }

      console.log('AuthUid do usuário:', currentUser.authUid);

      // Corrigir MIME type para JPG
      let contentType = `image/${fileExt}`;
      if (fileExt === 'jpg') {
        contentType = 'image/jpeg';
      }

      // Upload com service role (deve bypassar RLS)
      const { data, error: uploadError } = await supabase.storage
        .from('receipts')
        .upload(filePath, buffer, {
          contentType,
          cacheControl: '3600',
          upsert: true
        });

      if (uploadError) {
        console.error('Erro no upload para Supabase:', uploadError);
        return res.status(500).json({ 
          message: `Erro no upload: ${uploadError.message}`
        });
      }

      // Obter URL pública
      const { data: { publicUrl } } = supabase.storage
        .from('receipts')
        .getPublicUrl(filePath);
      
      res.json({ url: publicUrl });
    } catch (error: any) {
      console.error("Erro no upload:", error);
      res.status(500).json({ message: "Erro interno do servidor" });
    }
  });

  // Expense routes
  app.get("/api/expenses", requireAuth, async (req, res) => {
    try {
      const { year, month, category, contractNumber, paymentMethod } = req.query;

      const filters: any = {};

      // Administradores podem ver despesas de todos os usuários
      // Usuários regulares veem apenas suas próprias despesas
      if (req.session.userRole !== "admin") {
        filters.userId = req.session.userId;
      }
      // Para admins, não definimos userId no filtro, permitindo ver todas as despesas

      if (year && year !== "all") filters.year = year as string;
      if (month && month !== "all") filters.month = month as string;
      if (category && category !== "all") filters.category = category as string;
      if (contractNumber) filters.contractNumber = contractNumber as string;
      if (paymentMethod && paymentMethod !== "all") filters.paymentMethod = paymentMethod as string;

      const expenses = await storage.getExpenses(filters);
      res.json(expenses);
    } catch (error) {
      res.status(500).json({ message: "Server error" });
    }
  });

  app.post("/api/expenses", requireAuth, async (req, res) => {
    try {
      console.log('Dados recebidos para criação de despesa:', req.body);

      // Converter paymentDate de string para Date
      const bodyWithDate = {
        ...req.body,
        paymentDate: new Date(req.body.paymentDate)
      };

      const expenseData = insertExpenseSchema.parse(bodyWithDate);
      console.log('Dados validados:', expenseData);
      const expense = await storage.createExpense({
        ...expenseData,
        userId: req.session.userId!,
      });
      res.json(expense);
    } catch (error) {
      if (error instanceof z.ZodError) {
        console.error('Erro de validação Zod:', error.errors);
        return res.status(400).json({ message: "Invalid expense data", errors: error.errors });
      }
      console.error('Erro no servidor:', error);
      res.status(500).json({ message: "Server error" });
    }
  });

  app.put("/api/expenses/:id", requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const expenseData = insertExpenseSchema.partial().parse(req.body);

      const expense = await storage.updateExpense(id, expenseData);
      res.json(expense);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ message: "Invalid expense data", errors: error.errors });
      }
      res.status(500).json({ message: "Server error" });
    }
  });

  app.delete("/api/expenses/:id", requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      await storage.deleteExpense(id);
      res.json({ message: "Expense deleted successfully" });
    } catch (error) {
      res.status(500).json({ message: "Server error" });
    }
  });

  app.patch("/api/expenses/:id/cancel", requireAuth, async (req, res) => {
    try {
      const { id } = req.params;
      
      // Check if user has permission to cancel this expense
      const expense = await storage.getExpense(id);
      if (!expense) {
        return res.status(404).json({ message: "Expense not found" });
      }

      // Regular users can only cancel their own expenses
      if (req.session.userRole !== "admin" && expense.userId !== req.session.userId) {
        return res.status(403).json({ message: "Not authorized to cancel this expense" });
      }

      // Cancelar despesa adicionando prefixo [CANCELADA] na categoria
      const cancelledCategory = expense.category.startsWith('[CANCELADA]') 
        ? expense.category 
        : `[CANCELADA] ${expense.category}`;
      
      const updatedExpense = await storage.updateExpense(id, { 
        category: cancelledCategory 
      });
      res.json(updatedExpense);
    } catch (error) {
      console.error("Error cancelling expense:", error);
      res.status(500).json({ message: "Server error" });
    }
  });

  // Stats routes
  app.get("/api/stats", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userRole === "admin" ? undefined : req.session.userId;
      const stats = await storage.getExpenseStats(userId);
      res.json(stats);
    } catch (error) {
      res.status(500).json({ message: "Server error" });
    }
  });

  app.get("/api/stats/categories", requireAuth, async (req, res) => {
    try {
      const { month, contractNumber } = req.query;
      const filters: any = {};

      if (month && month !== "all") filters.month = month as string;
      if (contractNumber) filters.contractNumber = contractNumber as string;

      const stats = await storage.getCategoryStats(filters);
      res.json(stats);
    } catch (error) {
      res.status(500).json({ message: "Server error" });
    }
  });

  app.get("/api/stats/payment-methods", requireAuth, async (req, res) => {
    try {
      const { month, contractNumber } = req.query;
      const filters: any = {};

      if (month && month !== "all") filters.month = month as string;
      if (contractNumber) filters.contractNumber = contractNumber as string;

      const stats = await storage.getPaymentMethodStats(filters);
      res.json(stats);
    } catch (error) {
      res.status(500).json({ message: "Server error" });
    }
  });

  app.get("/api/stats/monthly", requireAuth, async (req, res) => {
    try {
      const stats = await storage.getMonthlyTrends();
      res.json(stats);
    } catch (error) {
      res.status(500).json({ message: "Server error" });
    }
  });

  // Billing routes (Auth required, admin for some operations)
  app.get("/api/billing", requireAuth, async (req, res) => {
    try {
      const { year, month, status, contractNumber } = req.query;
      const filters: any = {};

      // Usuários com mesma função podem ver dados uns dos outros
      if (req.session.userRole !== "admin") {
        // Para usuários não-admin, mostrar apenas seus próprios dados
        filters.userId = req.session.userId;
      }

      if (year) filters.year = year as string;
      if (month && month !== "all") filters.month = month as string;
      if (status && status !== "all") filters.status = status as string;
      if (contractNumber) filters.contractNumber = contractNumber as string;

      const billing = await billingStorage.getBilling(filters);
      res.json(billing);
    } catch (error) {
      console.error("Error fetching billing:", error);
      res.status(500).json({ message: "Erro ao carregar faturamento" });
    }
  });

  app.post("/api/billing", requireAuth, async (req, res) => {
    try {
      const billingData = req.body;
      const newBilling = await billingStorage.createBilling({
        ...billingData,
        userId: req.session.userId!,
      });
      res.status(201).json(newBilling);
    } catch (error) {
      console.error("Error creating billing:", error);
      res.status(500).json({ message: "Server error" });
    }
  });

  app.patch("/api/billing/:id", requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const updates = req.body;
      const updatedBilling = await billingStorage.updateBilling(id, updates);
      res.json(updatedBilling);
    } catch (error) {
      console.error("Error updating billing:", error);
      res.status(500).json({ message: "Server error" });
    }
  });

  app.patch("/api/billing/:id/cancel", requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const updatedBilling = await billingStorage.updateBilling(id, { status: 'cancelado' });
      res.json(updatedBilling);
    } catch (error) {
      console.error("Error cancelling billing:", error);
      res.status(500).json({ message: "Server error" });
    }
  });

  app.delete("/api/billing/:id", requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      await billingStorage.deleteBilling(id);
      res.status(204).send();
    } catch (error) {
      console.error("Error deleting billing:", error);
      res.status(500).json({ message: "Server error" });
    }
  });

  app.get("/api/billing/stats", requireAdmin, async (req, res) => {
    try {
      const stats = await billingStorage.getBillingStats();
      res.json(stats);
    } catch (error) {
      console.error("Error fetching billing stats:", error);
      res.status(500).json({ message: "Server error" });
    }
  });

  const httpServer = createServer(app);
  return httpServer;
}