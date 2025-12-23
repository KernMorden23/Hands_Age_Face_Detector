
const DB_NAME = 'biometricDB';

export const Database = {
    // 1. SELECT * FROM subjects
    getAll: () => {
        const raw = localStorage.getItem(DB_NAME);
        return raw ? JSON.parse(raw) : [];
    },

    // 2. INSERT INTO subjects ...
    add: (name, descriptor) => {
        const currentData = Database.getAll();
        
        // Create the new record object
        const newRecord = {
            label: name,
            descriptor: descriptor,
            timestamp: new Date().toISOString()
        };

        currentData.push(newRecord);
        
        // Save back to storage
        localStorage.setItem(DB_NAME, JSON.stringify(currentData));
        return newRecord;
    },

    // 3. DELETE FROM subjects ... (Optional helper)
    clear: () => {
        localStorage.removeItem(DB_NAME);
        console.log("Database Purged.");
    }
};