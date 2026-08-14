'use client'
import { useState } from 'react'
import axios from 'axios'
import toast from 'react-hot-toast'
import Title from './Title'

const Newsletter = () => {

    const [email, setEmail] = useState('')
    const [saving, setSaving] = useState(false)

    // Previously this discarded the address and reported success anyway.
    const handleSubscribe = async (e) => {
        e.preventDefault()
        setSaving(true)
        try {
            const { data } = await axios.post('/api/newsletter', { email })
            setEmail('')
            toast.success(data.message === 'Subscribed' ? "You're on the list." : data.message)
        } catch (error) {
            toast.error(error?.response?.data?.error || 'Could not subscribe. Please try again.')
        } finally {
            setSaving(false)
        }
    }

    return (
        <div className='flex flex-col items-center mx-4 my-36'>
            <Title title="Join the list" description="New arrivals and the occasional offer. No more than that, and you can leave whenever you like." visibleButton={false} />
            <form onSubmit={handleSubscribe} className='flex bg-slate-100 text-sm p-1 rounded-full w-full max-w-xl my-10 border-2 border-white ring ring-slate-200'>
                <input value={email} onChange={(e) => setEmail(e.target.value)} className='flex-1 pl-5 outline-none bg-transparent' type="email" placeholder='Enter your email address' required />
                <button type="submit" disabled={saving} className='font-medium bg-green-500 text-white px-7 py-3 rounded-full hover:scale-103 active:scale-95 transition disabled:opacity-60 disabled:hover:scale-100'>
                    {saving ? 'Adding…' : 'Subscribe'}
                </button>
            </form>
        </div>
    )
}

export default Newsletter
