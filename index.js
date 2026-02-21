// index.js - SILA MINI BOT Premium Manager 2026
require('dotenv').config();
const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;

// Security & Performance Middleware
app.use(helmet({
    contentSecurityPolicy: false,
}));
app.use(cors());
app.use(compression());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 200,
    message: 'Too many requests, please try again later.'
});
app.use('/api/', limiter);

// MongoDB Connection Pool
let mongoClient = null;
let db = null;
let isConnected = false;

// Connect to MongoDB with custom URL
app.post('/api/connect', async (req, res) => {
    try {
        const { url, database } = req.body;
        
        if (!url) {
            return res.status(400).json({ error: 'MongoDB URL is required' });
        }

        // Close existing connection if any
        if (mongoClient) {
            await mongoClient.close();
        }

        // Connect to new database
        mongoClient = new MongoClient(url, {
            maxPoolSize: 10,
            minPoolSize: 2,
            retryWrites: true,
            retryReads: true,
            connectTimeoutMS: 10000,
            serverSelectionTimeoutMS: 10000
        });

        await mongoClient.connect();
        
        // Get database name from URL or use provided one
        let dbName = database;
        if (!dbName) {
            // Extract from URL
            const urlObj = new URL(url);
            dbName = urlObj.pathname.replace('/', '') || 'test';
        }
        
        db = mongoClient.db(dbName);
        isConnected = true;

        // Test connection and get basic info
        const admin = db.admin();
        const serverInfo = await admin.serverInfo();
        const dbStats = await db.stats();

        res.json({
            success: true,
            message: 'Connected successfully',
            database: dbName,
            version: serverInfo.version,
            stats: {
                collections: dbStats.collections || 0,
                objects: dbStats.objects || 0,
                dataSize: dbStats.dataSize || 0
            }
        });

    } catch (error) {
        isConnected = false;
        console.error('Connection error:', error);
        res.status(500).json({ 
            error: 'Connection failed', 
            details: error.message 
        });
    }
});

// Get database info
app.get('/api/info', async (req, res) => {
    try {
        if (!isConnected || !db) {
            return res.status(503).json({ error: 'Not connected to any database' });
        }

        const stats = await db.stats();
        const collections = await db.listCollections().toArray();
        
        const collectionsData = await Promise.all(
            collections.map(async (col) => {
                const count = await db.collection(col.name).countDocuments();
                const sample = await db.collection(col.name).find().limit(1).toArray();
                return {
                    name: col.name,
                    count,
                    sample: sample[0] || null
                };
            })
        );

        res.json({
            connected: true,
            database: db.databaseName,
            stats: {
                collections: stats.collections,
                documents: stats.objects,
                dataSize: stats.dataSize,
                avgObjSize: stats.avgObjSize
            },
            collections: collectionsData
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get all collections
app.get('/api/collections', async (req, res) => {
    try {
        if (!isConnected || !db) {
            return res.status(503).json({ error: 'Not connected to any database' });
        }
        
        const collections = await db.listCollections().toArray();
        const collectionsWithStats = await Promise.all(
            collections.map(async (c) => {
                const count = await db.collection(c.name).countDocuments();
                return {
                    name: c.name,
                    documentCount: count,
                    type: c.type || 'collection'
                };
            })
        );
        
        res.json(collectionsWithStats);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get documents from collection with advanced filtering
app.get('/api/collections/:collectionName', async (req, res) => {
    try {
        if (!isConnected || !db) {
            return res.status(503).json({ error: 'Not connected to any database' });
        }
        
        const { collectionName } = req.params;
        const { 
            page = 1, 
            limit = 50, 
            sortBy = '_id', 
            sortOrder = 'desc',
            search = '',
            filter = '{}'
        } = req.query;
        
        const collection = db.collection(collectionName);
        const skip = (parseInt(page) - 1) * parseInt(limit);
        
        // Build query
        let query = {};
        if (search) {
            // Try to search in common fields
            const searchRegex = new RegExp(search, 'i');
            query = {
                $or: [
                    { _id: searchRegex },
                    { userId: searchRegex },
                    { user_id: searchRegex },
                    { username: searchRegex },
                    { user_name: searchRegex },
                    { chatId: searchRegex },
                    { chat_id: searchRegex },
                    { sessionId: searchRegex },
                    { session_id: searchRegex },
                    { phoneNumber: searchRegex },
                    { phone: searchRegex },
                    { email: searchRegex }
                ]
            };
        }
        
        // Add custom filter if provided
        if (filter !== '{}') {
            try {
                const customFilter = JSON.parse(filter);
                query = { ...query, ...customFilter };
            } catch (e) {
                // Invalid JSON, ignore
            }
        }
        
        const total = await collection.countDocuments(query);
        const documents = await collection.find(query)
            .sort({ [sortBy]: sortOrder === 'desc' ? -1 : 1 })
            .skip(skip)
            .limit(parseInt(limit))
            .toArray();
        
        // Get collection stats
        const stats = await collection.stats();
        
        // Get field types for better display
        const fields = new Set();
        documents.forEach(doc => {
            Object.keys(doc).forEach(key => fields.add(key));
        });
        
        res.json({
            documents,
            fields: Array.from(fields),
            pagination: {
                currentPage: parseInt(page),
                totalPages: Math.ceil(total / limit),
                totalDocuments: total,
                documentsPerPage: parseInt(limit),
                hasNextPage: skip + parseInt(limit) < total,
                hasPrevPage: page > 1
            },
            collection: {
                name: collectionName,
                size: stats.size,
                count: stats.count,
                avgObjSize: stats.avgObjSize,
                totalIndexSize: stats.totalIndexSize
            }
        });
    } catch (error) {
        console.error('Error fetching documents:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get single document
app.get('/api/collections/:collectionName/:id', async (req, res) => {
    try {
        const { collectionName, id } = req.params;
        const collection = db.collection(collectionName);
        
        let document;
        // Try different ID formats
        if (ObjectId.isValid(id)) {
            document = await collection.findOne({ _id: new ObjectId(id) });
        }
        
        if (!document) {
            document = await collection.findOne({ 
                $or: [
                    { sessionId: id },
                    { userId: id },
                    { chatId: id },
                    { _id: id }
                ]
            });
        }
        
        if (!document) {
            return res.status(404).json({ error: 'Document not found' });
        }
        
        res.json(document);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Update document
app.put('/api/collections/:collectionName/:id', async (req, res) => {
    try {
        const { collectionName, id } = req.params;
        const updates = req.body;
        
        delete updates._id; // Remove _id from updates
        
        const collection = db.collection(collectionName);
        
        let result;
        // Try different ID formats
        if (ObjectId.isValid(id)) {
            result = await collection.updateOne(
                { _id: new ObjectId(id) },
                { $set: { ...updates, updatedAt: new Date() } }
            );
        } else {
            result = await collection.updateOne(
                { $or: [
                    { sessionId: id },
                    { userId: id },
                    { chatId: id }
                ]},
                { $set: { ...updates, updatedAt: new Date() } }
            );
        }
        
        if (result.matchedCount === 0) {
            return res.status(404).json({ error: 'Document not found' });
        }
        
        res.json({
            success: true,
            message: 'Document updated successfully',
            modifiedCount: result.modifiedCount
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Delete document
app.delete('/api/collections/:collectionName/:id', async (req, res) => {
    try {
        const { collectionName, id } = req.params;
        const collection = db.collection(collectionName);
        
        let result;
        if (ObjectId.isValid(id)) {
            result = await collection.deleteOne({ _id: new ObjectId(id) });
        } else {
            result = await collection.deleteOne({ 
                $or: [
                    { sessionId: id },
                    { userId: id },
                    { chatId: id }
                ]
            });
        }
        
        if (result.deletedCount === 0) {
            return res.status(404).json({ error: 'Document not found' });
        }
        
        res.json({
            success: true,
            message: 'Document deleted successfully',
            deletedCount: result.deletedCount
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Bulk delete
app.post('/api/collections/:collectionName/bulk-delete', async (req, res) => {
    try {
        const { collectionName } = req.params;
        const { ids } = req.body;
        
        if (!ids || !Array.isArray(ids) || ids.length === 0) {
            return res.status(400).json({ error: 'No IDs provided' });
        }
        
        const collection = db.collection(collectionName);
        
        // Convert string IDs to ObjectId where valid
        const objectIds = ids.map(id => {
            if (ObjectId.isValid(id)) return new ObjectId(id);
            return id;
        });
        
        const result = await collection.deleteMany({
            $or: [
                { _id: { $in: objectIds.filter(id => id instanceof ObjectId) } },
                { sessionId: { $in: objectIds.filter(id => typeof id === 'string') } },
                { userId: { $in: objectIds.filter(id => typeof id === 'string') } },
                { chatId: { $in: objectIds.filter(id => typeof id === 'string') } }
            ]
        });
        
        res.json({
            success: true,
            message: `Successfully deleted ${result.deletedCount} documents`,
            deletedCount: result.deletedCount
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Disconnect
app.post('/api/disconnect', async (req, res) => {
    try {
        if (mongoClient) {
            await mongoClient.close();
            mongoClient = null;
            db = null;
            isConnected = false;
        }
        res.json({ success: true, message: 'Disconnected successfully' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({
        error: 'Something went wrong!',
        message: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
});

// Handle 404
app.use((req, res) => {
    res.status(404).json({ error: 'Route not found' });
});

app.listen(PORT, () => {
    console.log(`\n🚀 SILA MINI BOT Manager v2026`);
    console.log(`📡 Server: http://localhost:${PORT}`);
    console.log(`💾 Database: Ready to connect`);
    console.log(`✨ Status: Premium Edition\n`);
});
