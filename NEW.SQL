-- Sample tables
CREATE TABLE dbo.Doctors (
    DoctorID INT PRIMARY KEY,
    DoctorName NVARCHAR(200),
    Email NVARCHAR(200)
);

CREATE TABLE dbo.Patients (
    PatientID INT PRIMARY KEY,
    PatientName NVARCHAR(200),
    LastAppointmentDate DATETIME NULL,
    AppointmentCount INT DEFAULT 0
);

CREATE TABLE dbo.Appointments (
    AppointmentID INT IDENTITY PRIMARY KEY,
    PatientID INT NOT NULL,
    DoctorID INT NOT NULL,
    AppointmentDate DATETIME NOT NULL,
    Status NVARCHAR(50) NOT NULL, -- e.g., Scheduled, Completed, Cancelled
    Notes NVARCHAR(4000) NULL,
    CONSTRAINT FK_App_Patient FOREIGN KEY (PatientID) REFERENCES dbo.Patients(PatientID),
    CONSTRAINT FK_App_Doctor FOREIGN KEY (DoctorID) REFERENCES dbo.Doctors(DoctorID)
);

-- History table to record appointment snapshots
CREATE TABLE dbo.PatientAppointmentHistory (
    HistoryID INT IDENTITY PRIMARY KEY,
    AppointmentID INT,
    PatientID INT,
    DoctorID INT,
    AppointmentDate DATETIME,
    Status NVARCHAR(50),
    Notes NVARCHAR(4000),
    ChangedAt DATETIME DEFAULT SYSUTCDATETIME(),
    ChangeType NVARCHAR(10) -- 'INSERT' or 'UPDATE'
);
