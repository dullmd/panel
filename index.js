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
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Rate limiting - prevents abuse
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // limit each IP to 100 requests per windowMs
    message: 'Too many requests from this IP, please try again later.'
});
app.use('/api/', limiter);

// MongoDB Connection with retry logic
let db;
let isConnected = false;

const connectToMongoDB = async () => {
    try {
        const client = new MongoClient(process.env.MONGODB_URL, {
            maxPoolSize: 10,
            minPoolSize: 2,
            retryWrites: true,
            retryReads: true,
        });
        
        await client.connect();
        db = client.db('sila_bot_db'); // Bot database name
        isConnected = true;
        console.log('✅ SILA MINI BOT connected to MongoDB successfully');
        console.log(`📊 Database: sila_bot_db`);
        console.log(`🚀 Server running on port ${PORT}`);
        console.log(`🌐 Open http://localhost:${PORT} in your browser`);
    } catch (error) {
        console.error('❌ MongoDB connection error:', error);
        isConnected = false;
        // Retry after 5 seconds
        setTimeout(connectToMongoDB, 5000);
    }
};

connectToMongoDB();

// API Health Check
app.get('/api/health', (req, res) => {
    res.json({
        status: isConnected ? 'connected' : 'disconnected',
        timestamp: new Date().toISOString(),
        bot: 'SILA MINI BOT',
        version: '2026.1.0'
    });
});

// Get all collections
app.get('/api/collections', async (req, res) => {
    try {
        if (!isConnected) {
            return res.status(503).json({ error: 'Database not connected' });
        }
        
        const collections = await db.listCollections().toArray();
        const collectionNames = collections.map(c => c.name);
        
        // Get document counts for each collection
        const collectionsWithStats = await Promise.all(
            collectionNames.map(async (name) => {
                const count = await db.collection(name).countDocuments();
                return {
                    name,
                    documentCount: count
                };
            })
        );
        
        res.json(collectionsWithStats);
    } catch (error) {
        console.error('Error fetching collections:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get documents from a collection with filtering and sorting
app.get('/api/collections/:collectionName', async (req, res) => {
    try {
        if (!isConnected) {
            return res.status(503).json({ error: 'Database not connected' });
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
            query = {
                $or: [
                    { userId: { $regex: search, $options: 'i' } },
                    { chatId: { $regex: search, $options: 'i' } },
                    { sessionId: { $regex: search, $options: 'i' } },
                    { username: { $regex: search, $options: 'i' } }
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
        
        res.json({
            documents,
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
                avgObjSize: stats.avgObjSize
            }
        });
    } catch (error) {
        console.error('Error fetching documents:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get single document by ID
app.get('/api/collections/:collectionName/:id', async (req, res) => {
    try {
        const { collectionName, id } = req.params;
        const collection = db.collection(collectionName);
        
        let document;
        if (ObjectId.isValid(id)) {
            document = await collection.findOne({ _id: new ObjectId(id) });
        } else {
            document = await collection.findOne({ sessionId: id });
        }
        
        if (!document) {
            return res.status(404).json({ error: 'Document not found' });
        }
        
        res.json(document);
    } catch (error) {
        console.error('Error fetching document:', error);
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
        if (ObjectId.isValid(id)) {
            result = await collection.updateOne(
                { _id: new ObjectId(id) },
                { $set: { ...updates, updatedAt: new Date() } }
            );
        } else {
            result = await collection.updateOne(
                { sessionId: id },
                { $set: { ...updates, updatedAt: new Date() } }
            );
        }
        
        if (result.matchedCount === 0) {
            return res.status(404).json({ error: 'Document not found' });
        }
        
        // Get updated document
        const updatedDoc = await collection.findOne(
            ObjectId.isValid(id) ? { _id: new ObjectId(id) } : { sessionId: id }
        );
        
        res.json({
            success: true,
            message: 'Document updated successfully',
            document: updatedDoc
        });
    } catch (error) {
        console.error('Error updating document:', error);
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
            result = await collection.deleteOne({ sessionId: id });
        }
        
        if (result.deletedCount === 0) {
            return res.status(404).json({ error: 'Document not found' });
        }
        
        // Emit delete event (for realtime updates)
        // You can implement WebSocket here if needed
        
        res.json({
            success: true,
            message: 'Document deleted successfully',
            deletedCount: result.deletedCount
        });
    } catch (error) {
        console.error('Error deleting document:', error);
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
            if (ObjectId.isValid(id)) {
                return new ObjectId(id);
            }
            return id;
        });
        
        const result = await collection.deleteMany({
            $or: [
                { _id: { $in: objectIds.filter(id => id instanceof ObjectId) } },
                { sessionId: { $in: objectIds.filter(id => typeof id === 'string') } }
            ]
        });
        
        res.json({
            success: true,
            message: `Successfully deleted ${result.deletedCount} documents`,
            deletedCount: result.deletedCount
        });
    } catch (error) {
        console.error('Error in bulk delete:', error);
        res.status(500).json({ error: error.message });
    }
});

// Delete old sessions
app.delete('/api/collections/:collectionName/clean-old', async (req, res) => {
    try {
        const { collectionName } = req.params;
        const { days = 7, dateField = 'lastActive' } = req.query;
        
        const collection = db.collection(collectionName);
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - parseInt(days));
        
        const result = await collection.deleteMany({
            [dateField]: { $lt: cutoffDate }
        });
        
        res.json({
            success: true,
            message: `Deleted ${result.deletedCount} old sessions (older than ${days} days)`,
            deletedCount: result.deletedCount
        });
    } catch (error) {
        console.error('Error cleaning old sessions:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get database stats
app.get('/api/stats', async (req, res) => {
    try {
        const stats = await db.stats();
        const collections = await db.listCollections().toArray();
        
        const collectionsData = await Promise.all(
            collections.map(async (col) => {
                const count = await db.collection(col.name).countDocuments();
                return {
                    name: col.name,
                    count
                };
            })
        );
        
        res.json({
            database: 'sila_bot_db',
            totalCollections: collections.length,
            totalDocuments: stats.objects,
            totalSize: stats.dataSize,
            collections: collectionsData,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('Error getting stats:', error);
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
    console.log(`💾 Database: MongoDB Atlas`);
    console.log(`✨ Status: Premium Edition\n`);
});
