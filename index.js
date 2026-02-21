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

// Security & Performance
app.use(helmet({ contentSecurityPolicy: false }));
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

// MongoDB Connection
let mongoClient = null;
let db = null;
let isConnected = false;

// Connect to MongoDB
app.post('/api/connect', async (req, res) => {
    try {
        const { url, database } = req.body;
        
        if (!url) {
            return res.status(400).json({ error: 'MongoDB URL is required' });
        }

        // Close existing connection
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
        
        // Get database name
        let dbName = database;
        if (!dbName) {
            const urlObj = new URL(url);
            dbName = urlObj.pathname.replace('/', '') || 'test';
        }
        
        db = mongoClient.db(dbName);
        isConnected = true;

        // Get database stats
        const dbStats = await db.stats();
        const collections = await db.listCollections().toArray();

        res.json({
            success: true,
            message: 'Connected successfully',
            database: dbName,
            stats: {
                collections: dbStats.collections || 0,
                documents: dbStats.objects || 0,
                dataSize: dbStats.dataSize || 0
            },
            collections: collections.map(c => c.name)
        });

    } catch (error) {
        isConnected = false;
        console.error('Connection error:', error);
        res.status(500).json({ error: 'Connection failed', details: error.message });
    }
});

// Get database info
app.get('/api/info', async (req, res) => {
    try {
        if (!isConnected || !db) {
            return res.status(503).json({ error: 'Not connected' });
        }

        const stats = await db.stats();
        const collections = await db.listCollections().toArray();
        
        const collectionsData = await Promise.all(
            collections.map(async (col) => {
                const count = await db.collection(col.name).countDocuments();
                return { name: col.name, count };
            })
        );

        res.json({
            connected: true,
            database: db.databaseName,
            stats: {
                collections: stats.collections,
                documents: stats.objects,
                dataSize: stats.dataSize
            },
            collections: collectionsData
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get collections
app.get('/api/collections', async (req, res) => {
    try {
        if (!isConnected || !db) {
            return res.status(503).json({ error: 'Not connected' });
        }
        
        const collections = await db.listCollections().toArray();
        const collectionsWithStats = await Promise.all(
            collections.map(async (c) => {
                const count = await db.collection(c.name).countDocuments();
                return { name: c.name, documentCount: count };
            })
        );
        
        res.json(collectionsWithStats);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get documents
app.get('/api/collections/:collectionName', async (req, res) => {
    try {
        if (!isConnected || !db) {
            return res.status(503).json({ error: 'Not connected' });
        }
        
        const { collectionName } = req.params;
        const { page = 1, limit = 50, search = '' } = req.query;
        
        const collection = db.collection(collectionName);
        const skip = (parseInt(page) - 1) * parseInt(limit);
        
        // Build search query
        let query = {};
        if (search) {
            const searchRegex = new RegExp(search, 'i');
            // Get sample document to know fields
            const sample = await collection.findOne();
            if (sample) {
                const searchFields = Object.keys(sample).filter(key => 
                    typeof sample[key] === 'string' || typeof sample[key] === 'number'
                );
                query.$or = searchFields.map(field => ({
                    [field]: searchRegex
                }));
            }
        }
        
        const total = await collection.countDocuments(query);
        const documents = await collection.find(query)
            .skip(skip)
            .limit(parseInt(limit))
            .toArray();
        
        // Get all unique fields for display
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
                totalDocuments: total
            }
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get single document
app.get('/api/collections/:collectionName/:id', async (req, res) => {
    try {
        const { collectionName, id } = req.params;
        const collection = db.collection(collectionName);
        
        let document;
        if (ObjectId.isValid(id)) {
            document = await collection.findOne({ _id: new ObjectId(id) });
        }
        
        if (!document) {
            document = await collection.findOne({ 
                $or: [
                    { _id: id },
                    { id: id },
                    { userId: id },
                    { sessionId: id }
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
        
        delete updates._id;
        
        const collection = db.collection(collectionName);
        
        let result;
        if (ObjectId.isValid(id)) {
            result = await collection.updateOne(
                { _id: new ObjectId(id) },
                { $set: updates }
            );
        } else {
            result = await collection.updateOne(
                { $or: [{ _id: id }, { id: id }, { userId: id }] },
                { $set: updates }
            );
        }
        
        res.json({ success: true, modifiedCount: result.modifiedCount });
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
                $or: [{ _id: id }, { id: id }, { userId: id }]
            });
        }
        
        res.json({ success: true, deletedCount: result.deletedCount });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Bulk delete
app.post('/api/collections/:collectionName/bulk-delete', async (req, res) => {
    try {
        const { collectionName } = req.params;
        const { ids } = req.body;
        
        const collection = db.collection(collectionName);
        
        const objectIds = ids.map(id => {
            if (ObjectId.isValid(id)) return new ObjectId(id);
            return id;
        });
        
        const result = await collection.deleteMany({
            $or: [
                { _id: { $in: objectIds.filter(id => id instanceof ObjectId) } },
                { id: { $in: objectIds.filter(id => typeof id === 'string') } },
                { userId: { $in: objectIds } },
                { sessionId: { $in: objectIds } }
            ]
        });
        
        res.json({ success: true, deletedCount: result.deletedCount });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`\n🚀 SILA MINI BOT Manager v2026`);
    console.log(`📡 Server: http://localhost:${PORT}`);
    console.log(`✨ Premium Edition - Blue in Black\n`);
});
